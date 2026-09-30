import {
  SK_COURT_REGISTRY_TIERS,
  SK_COURT_TIERS,
} from "@stll/api-contract/sk-court-tiers";
import { readCappedBytes } from "@stll/skills/streaming";

import { ADAPTER_KEYS, ADAPTER_TIMEOUT } from "@/api/handlers/case-law/consts";
import { fetchPublisher } from "@/api/handlers/case-law/ingestion/adapters/retry";
import { isNullishString } from "@/api/handlers/case-law/ingestion/adapters/utils";
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
      type,
    });
  }
  return {
    courtRegistry: {
      registreGuid: record.registreGuid,
      nazov: record.nazov,
      sudId: record.sudId,
      typSudu: record.typSudu,
      nadriadenySudId: record.nadriadenySudId,
      ukonceny_string: record.ukonceny_string,
      skratka_string: record.skratka_string,
    },
    courtClassification:
      tier === undefined
        ? { status: "unclassified", statedType: type }
        : { status: "classified", ...tier },
    // Equal registry IDs establish an alias, never a distinct court's succession.
    courtAlias:
      statedName === record.nazov
        ? undefined
        : {
            type: "same-registry-id",
            registreGuid: record.registreGuid,
            statedName,
            registryName: record.nazov,
          },
  } as const;
};

export type SkCourtRegistryReader = (
  registreGuid: string,
) => Promise<SkCourtRegistryRecord>;

/** Page-owned promise cache: bounded by the page, discarded on completion. */
export const createSkCourtRegistryReader = (
  signal?: AbortSignal,
): SkCourtRegistryReader => {
  const records = new Map<string, Promise<SkCourtRegistryRecord>>();
  return (registreGuid) => {
    const cached = records.get(registreGuid);
    if (cached !== undefined) {
      return cached;
    }
    const pending = (async () => {
      const response = await fetchPublisher(
        `https://obcan.justice.sk/pilot/api/ress-isu-service/v1/sud/${encodeURIComponent(registreGuid)}`,
        {
          adapterKey: ADAPTER_KEYS.SK_COURTS,
          signal,
          timeoutMs: ADAPTER_TIMEOUT.REQUEST,
          headers: { Accept: "application/json" },
        },
      );
      const bytes =
        response.ok && response.body !== null
          ? await readCappedBytes(response.body, MAX_REGISTRY_RESPONSE_BYTES)
          : null;
      const json: unknown =
        bytes === null ? null : JSON.parse(new TextDecoder().decode(bytes));
      if (
        !isSkCourtRegistryRecord(json) ||
        json.registreGuid !== registreGuid
      ) {
        throw new AdapterFetchError({
          adapterKey: ADAPTER_KEYS.SK_COURTS,
          cursor: null,
          message: `Court registry record unavailable or invalid: ${registreGuid}`,
        });
      }
      return json;
    })();
    records.set(registreGuid, pending);
    return pending;
  };
};
