// parser-output-unchanged: listing-stage labels do not alter directory parsing.
import { panic, Result } from "better-result";

import {
  SK_COURT_REGISTRY_TIERS,
  SK_COURT_TIERS,
} from "@stll/api-contract/sk-court-tiers";
import { readCappedBytes } from "@stll/skills/streaming";

import { ADAPTER_KEYS, ADAPTER_TIMEOUT } from "@/api/handlers/case-law/consts";
import { readPublisher } from "@/api/handlers/case-law/ingestion/adapters/publisher-read";
import { isNullishString } from "@/api/handlers/case-law/ingestion/adapters/utils";
import {
  isReadRefusal,
  isStoredReadAbsence,
  type ReadRefusal,
  type ReadUnavailableCause,
  type StoredReadAbsence,
} from "@/api/lib/errors/read-outcome";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";
import { isRecord } from "@/api/lib/type-guards";

export type SkCourtRegistryRecord = Readonly<Record<string, unknown>> & {
  registreGuid: string;
  nazov: string;
  typSudu?: string | null;
  sudId?: string | null;
  nadriadenySudId?: string | null;
  ukonceny_string?: string | null;
  skratka_string?: string | null;
};

const REGISTRY_UNAVAILABILITY_REASONS = [
  "http-refusal",
  "response-too-large",
  "invalid-json",
  "invalid-shape",
] as const;

/**
 * A registry answer that served a body this reader cannot use. `http-refusal`
 * is the disposition rows stored under sk-courts parser version 10 or lower
 * carry for a 401, 403, 404 or 410; replay still reads it, and a status that
 * is neither transient, refused nor absent is reported under it.
 */
export type SkCourtRegistryUnavailable = {
  status: "unavailable";
  httpStatus: number;
  reason: (typeof REGISTRY_UNAVAILABILITY_REASONS)[number];
};

/**
 * A registry record the decision is stored without: refused (a typed part
 * refusal, re-checked on the normal cadence), stated absent, or unusable.
 */
export type SkCourtRegistryWithheld =
  | SkCourtRegistryUnavailable
  | { status: "refused"; refusal: ReadRefusal }
  | { status: "absent"; absence: StoredReadAbsence };

export type SkCourtRegistryObservation =
  | { status: "available"; record: SkCourtRegistryRecord }
  | SkCourtRegistryWithheld;

const isSkCourtRegistryUnavailable = (
  value: unknown,
): value is SkCourtRegistryUnavailable =>
  isRecord(value) &&
  value["status"] === "unavailable" &&
  typeof value["httpStatus"] === "number" &&
  REGISTRY_UNAVAILABILITY_REASONS.some((reason) => reason === value["reason"]);

export const isSkCourtRegistryWithheld = (
  value: unknown,
): value is SkCourtRegistryWithheld =>
  isSkCourtRegistryUnavailable(value) ||
  (isRecord(value) &&
    ((value["status"] === "refused" && isReadRefusal(value["refusal"])) ||
      (value["status"] === "absent" && isStoredReadAbsence(value["absence"]))));

const skCourtDefunctState = (stated: string | null | undefined) => {
  if (stated === "true") {
    return true;
  }
  if (stated === "false") {
    return false;
  }
  return "not_stated" as const;
};

export const isSkCourtRegistryRecord = (
  value: unknown,
): value is SkCourtRegistryRecord =>
  isRecord(value) &&
  typeof value["registreGuid"] === "string" &&
  typeof value["nazov"] === "string" &&
  [
    "typSudu",
    "sudId",
    "nadriadenySudId",
    "ukonceny_string",
    "skratka_string",
  ].every((key) => isNullishString(value[key]));

const isKnownCourtType = (
  value: string,
): value is keyof typeof SK_COURT_TIERS => Object.hasOwn(SK_COURT_TIERS, value);

const hasRegistryTier = (
  value: string,
): value is keyof typeof SK_COURT_REGISTRY_TIERS =>
  Object.hasOwn(SK_COURT_REGISTRY_TIERS, value);

const MAX_REGISTRY_RESPONSE_BYTES = 1024 * 1024;

/** Statuses after which the same request may answer on a later attempt. */
const isTransientRegistryStatus = (status: number): boolean =>
  status >= 500 || [408, 425, 429].includes(status);

/** No name guessing: an unrecognised publisher type stays observable. */
export const skCourtDirectoryMetadata = (
  record: SkCourtRegistryRecord,
  statedName: string,
) => {
  const type = record.typSudu;
  const statedTier =
    typeof type === "string" && isKnownCourtType(type)
      ? SK_COURT_TIERS[type]
      : undefined;
  const tier = hasRegistryTier(record.registreGuid)
    ? SK_COURT_REGISTRY_TIERS[record.registreGuid]
    : statedTier;
  if (tier === undefined) {
    logger.warn("case_law.ingestion.unknown_court_type", {
      adapterKey: ADAPTER_KEYS.SK_COURTS,
      registreGuid: record.registreGuid,
      type: type ?? "not_stated",
    });
  }
  return {
    courtRegistry: {
      status: "available" as const,
      registreGuid: record.registreGuid,
      nazov: record.nazov,
      sudId: record.sudId,
      typSudu: record.typSudu,
      nadriadenySudId: record.nadriadenySudId,
      ukonceny_string: record.ukonceny_string,
      defunct: skCourtDefunctState(record.ukonceny_string),
      skratka_string: record.skratka_string,
    },
    courtClassification:
      tier === undefined
        ? { status: "unclassified" as const, statedType: type }
        : {
            status: "classified" as const,
            level: tier.level,
            jurisdiction: tier.jurisdiction,
          },
    // Equal registry IDs establish an alias, never a distinct court's succession.
    courtAlias:
      statedName === record.nazov
        ? undefined
        : {
            type: "same-registry-id" as const,
            registreGuid: record.registreGuid,
            statedName,
            registryName: record.nazov,
          },
  };
};

export type SkCourtRegistryReader = (
  registreGuid: string,
  signal?: AbortSignal,
) => Promise<Result<SkCourtRegistryObservation, AdapterFetchError>>;

/** Page-owned promise cache: bounded by the page, discarded on completion. */
export const createSkCourtRegistryReader = (
  signal?: AbortSignal,
): SkCourtRegistryReader => {
  const records = new Map<string, ReturnType<SkCourtRegistryReader>>();
  return async (registreGuid, requestSignal) => {
    const cached = records.get(registreGuid);
    if (cached !== undefined) {
      return await cached;
    }
    const registryError = (cause?: unknown) =>
      new AdapterFetchError({
        adapterKey: ADAPTER_KEYS.SK_COURTS,
        cursor: null,
        message: `Court registry record unavailable or invalid: ${registreGuid}`,
        cause,
      });
    const temporarilyUnavailable = (httpStatus: number) =>
      Result.err(
        new AdapterFetchError({
          adapterKey: ADAPTER_KEYS.SK_COURTS,
          cursor: null,
          httpStatus,
          message: `Court registry temporarily unavailable: ${registreGuid}`,
        }),
      );
    const pending = (async () => {
      const fetched = await Result.tryPromise({
        try: async () =>
          await readPublisher(
            `https://obcan.justice.sk/pilot/api/ress-isu-service/v1/sud/${encodeURIComponent(registreGuid)}`,
            {
              fetchStage: "listing",
              adapterKey: ADAPTER_KEYS.SK_COURTS,
              // The decision is read without the record: a part.
              refusalScope: "part",
              signal: requestSignal ?? signal,
              timeoutMs: ADAPTER_TIMEOUT.REQUEST,
              headers: { Accept: "application/json" },
            },
          ),
        catch: registryError,
      });
      if (fetched.isErr()) {
        return fetched;
      }
      const read = fetched.value;
      const unavailable = (
        httpStatus: number,
        reason: SkCourtRegistryUnavailable["reason"],
      ) => {
        logger.warn("case_law.ingestion.court_registry_unavailable", {
          adapterKey: ADAPTER_KEYS.SK_COURTS,
          registreGuid,
          httpStatus,
          reason,
        });
        return Result.ok({
          status: "unavailable",
          httpStatus,
          reason,
        } as const);
      };
      const withheld = (
        observation: Exclude<
          SkCourtRegistryWithheld,
          SkCourtRegistryUnavailable
        >,
      ) => {
        logger.warn("case_law.ingestion.court_registry_withheld", {
          adapterKey: ADAPTER_KEYS.SK_COURTS,
          registreGuid,
          outcome: observation.status,
        });
        return Result.ok(observation);
      };
      const unread = (cause: ReadUnavailableCause) => {
        switch (cause.kind) {
          case "thrown":
            return Result.err(registryError(cause.error));
          case "too-large":
            return Result.err(registryError(cause));
          // A served answer with no record in it states nothing about the
          // court; the page is read again rather than stored without it.
          case "no-content":
          case "empty-body":
            return temporarilyUnavailable(cause.status);
          case "status":
            return isTransientRegistryStatus(cause.status)
              ? temporarilyUnavailable(cause.status)
              : unavailable(cause.status, "http-refusal");
          default:
            cause satisfies never;
            return panic(`Unhandled read cause: ${String(cause)}`);
        }
      };
      switch (read.type) {
        case "present":
          break;
        case "absent":
          return withheld({
            status: "absent",
            absence: { type: "absent", evidence: read.evidence },
          });
        case "refused":
          return withheld({ status: "refused", refusal: read });
        case "unavailable":
          return unread(read.cause);
        default:
          read satisfies never;
          return panic(`Unhandled registry read: ${String(read)}`);
      }
      const response = read.value;
      const body = await Result.tryPromise({
        try: async () =>
          response.body === null
            ? new Uint8Array()
            : await readCappedBytes(response.body, MAX_REGISTRY_RESPONSE_BYTES),
        catch: registryError,
      });
      if (body.isErr()) {
        return body;
      }
      const bytes = body.value;
      if (bytes === null) {
        return unavailable(response.status, "response-too-large");
      }
      if (bytes.length === 0) {
        return temporarilyUnavailable(response.status);
      }
      const parsed = Result.try({
        try: (): unknown => JSON.parse(new TextDecoder().decode(bytes)),
        catch: registryError,
      });
      if (parsed.isErr()) {
        return unavailable(response.status, "invalid-json");
      }
      const json = parsed.value;
      if (
        !isSkCourtRegistryRecord(json) ||
        json.registreGuid !== registreGuid
      ) {
        return unavailable(response.status, "invalid-shape");
      }
      return Result.ok({ status: "available", record: json } as const);
    })().then((result) => {
      if (result.isErr()) {
        records.delete(registreGuid);
      }
      return result;
    });
    records.set(registreGuid, pending);
    return await pending;
  };
};
