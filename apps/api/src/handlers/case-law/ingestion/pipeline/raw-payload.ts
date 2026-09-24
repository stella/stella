import { Result } from "better-result";

import { withSourceRawObjects } from "@/api/handlers/case-law/ingestion/adapter";
import type {
  IngestionResult,
  SourceRawObjectRef,
} from "@/api/handlers/case-law/ingestion/adapter";
import type { SafeId } from "@/api/lib/branded-types";
import {
  copyRawObject,
  homeRawPayloadObjects,
  RAW_SOURCE_FAMILY,
  rawSourcePayloadKey,
  sourceBinaryRef,
  writeCaseLawRawPayload,
  writeSourceBinary,
} from "@/api/lib/legal-search/raw-source-storage";
import type {
  RawSourceWriteFailure,
  RawSourceWriteWindow,
} from "@/api/lib/legal-search/raw-source-storage";
import { logger } from "@/api/lib/observability/logger";

/** Wall-clock bound on copying one file an envelope names into its decision. */
export const RAW_OBJECT_COPY_TIMEOUT_MS = 60_000;

type PlanSourceRawPayloadOptions = {
  result: IngestionResult;
  sourceId: SafeId<"caseLawSource">;
  decisionId: SafeId<"caseLawDecision">;
};

/** The raw payload a row stores, and the publisher files it names. */
type SourceRawPayloadPlan = {
  payload: Uint8Array | string;
  /** Only the files the payload names: anything else would be unreachable. */
  files: readonly {
    bytes: Uint8Array;
    contentType: string;
    ref: SourceRawObjectRef;
  }[];
};

/**
 * The raw payload this row stores, with its binary parts resolved to the
 * addresses they are (or will be) stored at. Pure: the addresses are derived
 * from the decision and the bytes, so whether anything needs writing can be
 * decided before any write.
 *
 * An adapter that hands over bytes without an envelope still has them
 * stored as the payload itself, which is the shape every adapter wrote
 * before parts existed and the one `LEGACY_RAW_SHAPES` describes.
 */
const planSourceRawPayload = ({
  result,
  sourceId,
  decisionId,
}: PlanSourceRawPayloadOptions): SourceRawPayloadPlan | undefined => {
  if (result.sourceRawBytes !== undefined) {
    return { payload: result.sourceRawBytes, files: [] };
  }
  if (result.sourceRaw === undefined) {
    return undefined;
  }
  const files = Object.entries(result.sourceRawObjects ?? {}).map(
    ([part, { bytes, contentType }]) => ({
      part,
      bytes,
      contentType,
      ref: sourceBinaryRef({
        family: RAW_SOURCE_FAMILY.CASE_LAW,
        sourceId,
        documentId: decisionId,
        bytes,
        contentType,
      }),
    }),
  );
  const payload =
    files.length === 0
      ? result.sourceRaw
      : withSourceRawObjects(
          result.sourceRaw,
          Object.fromEntries(files.map(({ part, ref }) => [part, ref])),
        );
  // A payload that is not an envelope cannot name the files, and a file
  // nothing names is one no reader would ever look for.
  if (files.length > 0 && payload === result.sourceRaw) {
    logger.error("case_law.ingestion.source_files_without_envelope", {
      sourceId,
      caseNumber: result.caseNumber,
      files: files.length,
    });
    return { payload, files: [] };
  }
  return { payload, files };
};

type WriteOwnedRawPayloadOptions = {
  result: IngestionResult;
  sourceId: SafeId<"caseLawSource">;
  /** The decision whose prefix holds the payload and the files it names. */
  ownerId: SafeId<"caseLawDecision">;
  contentType: string;
  /** The key the pointer being written already records, or null. */
  storedKey: string | null;
  storedContentType: string | null;
  window: RawSourceWriteWindow;
  /** Called once, before the first object write this call starts. */
  onWriteStart?: () => void;
};

/**
 * Store an observation's payload and the files it names under one
 * decision's prefix, answering its key, or undefined when the observation
 * carries none. Every write is content-addressed and created only if absent,
 * so a retry after a failure between them lands nothing twice.
 */
export const writeOwnedRawPayload = async ({
  result,
  sourceId,
  ownerId,
  contentType,
  storedKey,
  storedContentType,
  window,
  onWriteStart,
}: WriteOwnedRawPayloadOptions): Promise<
  Result<string | undefined, RawSourceWriteFailure>
> => {
  const plan = planSourceRawPayload({ result, sourceId, decisionId: ownerId });
  if (plan === undefined) {
    return Result.ok(undefined);
  }
  const owner = {
    family: RAW_SOURCE_FAMILY.CASE_LAW,
    sourceId,
    documentId: ownerId,
  } as const;
  // A payload read back from storage (a replay) names files where they
  // were stored before; those are copied under this decision, so its
  // erasure reaches them and no other decision's can.
  const homed = homeRawPayloadObjects({ payload: plan.payload, owner });
  if (Result.isError(homed)) {
    return homed;
  }
  // The publisher's files first: the envelope names them, so it is
  // never stored before they are. That order is also why a row that
  // already records this exact envelope proves its files are stored,
  // and an unchanged observation writes nothing at all.
  const payloadAlreadyStored =
    storedKey === rawSourcePayloadKey({ owner, data: homed.value.payload }) &&
    storedContentType === contentType;
  if (!payloadAlreadyStored) {
    onWriteStart?.();
    for (const { bytes, contentType: fileContentType } of plan.files) {
      const file = await writeSourceBinary({
        ...owner,
        bytes,
        contentType: fileContentType,
        window,
      });
      if (Result.isError(file)) {
        return file;
      }
    }
    for (const copy of homed.value.copies) {
      const copied = await copyRawObject({
        copy,
        window,
        signal: AbortSignal.timeout(RAW_OBJECT_COPY_TIMEOUT_MS),
      });
      if (Result.isError(copied)) {
        return copied;
      }
    }
  }
  // Failing here holds the page cursor; see `rawWriteFailed` and
  // `writeRawSourcePayload` for why that is safe.
  return await writeCaseLawRawPayload({
    owner,
    window,
    data: homed.value.payload,
    contentType,
    storedKey,
    storedContentType,
  });
};
