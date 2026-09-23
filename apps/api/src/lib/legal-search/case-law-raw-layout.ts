import { panic, Result } from "better-result";
import { and, asc, eq, gt, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  enqueueCaseLawRawSweepTx,
  rawSweepSettleAfter,
} from "@/api/lib/legal-search/case-law-raw-sweeps";
import {
  decodeSourceRawEnvelopeObjects,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/lib/legal-search/ingestion-types";
import {
  classifyCaseLawRawKey,
  copyRawObject,
  rawDocumentPayloadKey,
  homeRawPayloadObjects,
  isUnmovableRawObjectError,
  openRawSourceWriteWindow,
  RAW_KEY_OWNERSHIP,
  RAW_SOURCE_FAMILY,
  rawSourcePayloadKey,
  writeRawSourcePayload,
} from "@/api/lib/legal-search/raw-source-storage";
import type {
  RawDocumentOwner,
  RawObjectCopy,
  RawSourceWriteWindow,
} from "@/api/lib/legal-search/raw-source-storage";
import { headS3ObjectWithSignal, readS3ObjectIfPresent } from "@/api/lib/s3";

/**
 * Every decision's raw pointer, reconciled against the per-decision layout.
 *
 * Before raw keys were per decision, a payload and the files it names were
 * stored once per source under their digest, so two decisions served the
 * same bytes shared one object and neither could be erased without the
 * other. A decision still in that layout gets its own copy here: its files,
 * then its payload naming them at their new address, then its pointer,
 * compare-and-set on the pointer it was read with. Nothing is deleted: the
 * source-wide objects stay until nothing live names that layout, which the
 * operator's legacy sweep proves before it deletes them.
 *
 * A decision already in its own prefix is checked instead: its payload is
 * stored, and every file its envelope names is its own and stored. That is
 * the projection census for raw storage from the row side; the object side,
 * objects no live row owns, is `case-law-raw-census.ts`.
 *
 * Every write is created only if absent at an address derived from the
 * bytes, and the pointer only moves from the key it was read with, so a
 * page replayed from any point converges on the same state.
 */

export const RAW_LAYOUT_MODE = {
  /** Read and report what applying would do; write nothing. */
  PLAN: "plan",
  APPLY: "apply",
} as const;

export type RawLayoutMode =
  (typeof RAW_LAYOUT_MODE)[keyof typeof RAW_LAYOUT_MODE];

/** What became of one decision a page read. */
export const RAW_LAYOUT_ROW_OUTCOME = {
  /** In its own prefix with everything it names stored, or holding no raw. */
  CURRENT: "current",
  /** Moved into its own prefix (or, in a plan, would be). */
  MIGRATED: "migrated",
  /** Erased, or repointed by a writer, between the read and the move. */
  OVERTAKEN: "overtaken",
  /**
   * Outside its own prefix, but the pointer names an object that is not
   * stored, or a file its payload names is absent or does not match its
   * digest. Nothing can be moved; the row keeps its source's older objects
   * from being swept until it is re-observed.
   */
  UNMOVABLE: "unmovable",
  /** In its own prefix, but its payload or a file it names is not stored. */
  DANGLING: "dangling",
  /** Failed in a way a later attempt may not; reported and tried next pass. */
  RETRY: "retry",
} as const;

export type RawLayoutRowOutcome =
  (typeof RAW_LAYOUT_ROW_OUTCOME)[keyof typeof RAW_LAYOUT_ROW_OUTCOME];

type RawLayoutRow = {
  id: SafeId<"caseLawDecision">;
  sourceId: SafeId<"caseLawSource">;
  sourceRawS3Key: string | null;
  sourceRawContentType: string | null;
  redactedAt: Date | null;
};

const RAW_LAYOUT_IO_TIMEOUT_MS = 60_000;

/**
 * A payload's bytes as the text an envelope is, or as bytes when they are
 * not text. Only read for the files it names: a payload that names none is
 * stored again as the exact bytes it was read as.
 */
const payloadText = (bytes: Uint8Array): Uint8Array | string =>
  Result.try({
    try: () =>
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    catch: () => null,
  }).unwrapOr(null) ?? bytes;

/** Whether the store holds the key; any other failure is raised. */
const isStored = async (key: string, signal: AbortSignal): Promise<boolean> =>
  (await headS3ObjectWithSignal(key, signal)) !== null;

/** Largest payload read into this process to find the files it names. */
const RAW_ENVELOPE_READ_MAX_BYTES = 64 * 1024 * 1024;

type ReconcileRawRowOptions = {
  scopedDb: ScopedDb;
  row: RawLayoutRow;
  mode: RawLayoutMode;
  window: RawSourceWriteWindow;
  /**
   * Read every payload for the files it names, not only those recorded as
   * envelopes. What the legacy sweep's census asks; the recurring walk reads
   * envelopes, the only payloads a writer names files in.
   */
  readEveryPayload: boolean;
};

type RawRowReconciliation = { outcome: RawLayoutRowOutcome; copies: number };

/** Reconcile one decision's raw pointer with the per-decision layout. */
const reconcileRawRow = async ({
  scopedDb,
  row,
  mode,
  window,
  readEveryPayload,
}: ReconcileRawRowOptions): Promise<RawRowReconciliation> => {
  if (row.redactedAt !== null || row.sourceRawS3Key === null) {
    return { outcome: RAW_LAYOUT_ROW_OUTCOME.CURRENT, copies: 0 };
  }
  const storedKey = row.sourceRawS3Key;
  const owner = {
    family: RAW_SOURCE_FAMILY.CASE_LAW,
    sourceId: row.sourceId,
    documentId: row.id,
  } as const;
  const own = classifyCaseLawRawKey(storedKey, owner) === RAW_KEY_OWNERSHIP.OWN;
  const signal = AbortSignal.timeout(RAW_LAYOUT_IO_TIMEOUT_MS);

  const head = await headS3ObjectWithSignal(storedKey, signal);
  if (head === null) {
    return {
      outcome: own
        ? RAW_LAYOUT_ROW_OUTCOME.DANGLING
        : RAW_LAYOUT_ROW_OUTCOME.UNMOVABLE,
      copies: 0,
    };
  }
  // Only an envelope names files; a writer stores one under the envelope's
  // media type. The legacy sweep's census reads every payload regardless.
  const envelope =
    head.contentType?.startsWith(SOURCE_RAW_ENVELOPE_CONTENT_TYPE) === true;
  const readable =
    head.contentLength !== null &&
    head.contentLength <= RAW_ENVELOPE_READ_MAX_BYTES;
  if (!envelope && !(readEveryPayload && readable)) {
    return own
      ? { outcome: RAW_LAYOUT_ROW_OUTCOME.CURRENT, copies: 0 }
      : await movePayload({
          scopedDb,
          row,
          mode,
          window,
          storedKey,
          owner,
          signal,
          plan: {
            type: "copy",
            byteLength: head.contentLength ?? -1,
            contentType: head.contentType ?? "application/octet-stream",
          },
        });
  }
  if (!readable) {
    return {
      outcome: own
        ? RAW_LAYOUT_ROW_OUTCOME.DANGLING
        : RAW_LAYOUT_ROW_OUTCOME.UNMOVABLE,
      copies: 0,
    };
  }

  const read = await readS3ObjectIfPresent(storedKey, signal);
  if (read === null) {
    return {
      outcome: own
        ? RAW_LAYOUT_ROW_OUTCOME.DANGLING
        : RAW_LAYOUT_ROW_OUTCOME.UNMOVABLE,
      copies: 0,
    };
  }
  const storedBytes = new Uint8Array(read);
  const text = payloadText(storedBytes);
  const homing = Result.try({
    try: () => homeRawPayloadObjects({ payload: text, owner }),
    catch: (cause) => cause,
  });
  if (Result.isError(homing)) {
    if (isUnmovableRawObjectError(homing.error)) {
      return { outcome: RAW_LAYOUT_ROW_OUTCOME.UNMOVABLE, copies: 0 };
    }
    throw homing.error;
  }
  const { copies } = homing.value;

  if (own && copies.length === 0) {
    // Everything it names is its own: the census question is whether it is
    // all stored.
    const named = Object.values(
      typeof text === "string" ? decodeSourceRawEnvelopeObjects(text) : {},
    );
    const stored = await Promise.all(
      named.map(async ({ location }) => await isStored(location, signal)),
    );
    return {
      outcome: stored.every(Boolean)
        ? RAW_LAYOUT_ROW_OUTCOME.CURRENT
        : RAW_LAYOUT_ROW_OUTCOME.DANGLING,
      copies: 0,
    };
  }
  if (!envelope && copies.length === 0 && !own) {
    // Read only for the census: it names nothing, so it moves as bytes.
    return await movePayload({
      scopedDb,
      row,
      mode,
      window,
      storedKey,
      owner,
      signal,
      plan: {
        type: "copy",
        byteLength: storedBytes.byteLength,
        contentType: head.contentType ?? "application/octet-stream",
      },
    });
  }
  return await movePayload({
    scopedDb,
    row,
    mode,
    window,
    storedKey,
    owner,
    signal,
    plan: {
      type: "write",
      payload: copies.length === 0 ? storedBytes : homing.value.payload,
      copies,
    },
  });
};

type MovePayloadOptions = {
  scopedDb: ScopedDb;
  row: RawLayoutRow;
  mode: RawLayoutMode;
  window: RawSourceWriteWindow;
  storedKey: string;
  owner: RawDocumentOwner & { family: typeof RAW_SOURCE_FAMILY.CASE_LAW };
  signal: AbortSignal;
  plan:
    | {
        /**
         * A payload that names no files, copied server-side under the same
         * digest: it is never read into this process.
         */
        type: "copy";
        byteLength: number;
        contentType: string;
      }
    | {
        /** An envelope rewritten to name its files' new addresses. */
        type: "write";
        payload: Uint8Array | string;
        copies: RawObjectCopy[];
      };
};

/**
 * Put a decision's payload, and every file it names, under its own prefix,
 * then move its pointer compare-and-set on the key it was read with.
 */
const movePayload = async ({
  scopedDb,
  row,
  mode,
  window,
  storedKey,
  owner,
  signal,
  plan,
}: MovePayloadOptions): Promise<RawRowReconciliation> => {
  const digest = storedKey.slice(storedKey.lastIndexOf("/") + 1);
  const copies =
    plan.type === "write"
      ? plan.copies
      : [
          {
            fromKey: storedKey,
            ref: {
              location: rawDocumentPayloadKey(owner, digest),
              sha256: digest,
              contentType: plan.contentType,
              byteLength: plan.byteLength,
            },
          },
        ];
  if (mode === RAW_LAYOUT_MODE.PLAN) {
    const sources = await Promise.all(
      copies.map(async ({ fromKey }) => await isStored(fromKey, signal)),
    );
    return {
      outcome: sources.every(Boolean)
        ? RAW_LAYOUT_ROW_OUTCOME.MIGRATED
        : RAW_LAYOUT_ROW_OUTCOME.UNMOVABLE,
      copies: copies.length,
    };
  }

  for (const copy of copies) {
    const copied = await Result.tryPromise({
      try: async () => await copyRawObject({ copy, window, signal }),
      catch: (cause) => cause,
    });
    if (Result.isError(copied)) {
      if (isUnmovableRawObjectError(copied.error)) {
        return { outcome: RAW_LAYOUT_ROW_OUTCOME.UNMOVABLE, copies: 0 };
      }
      throw copied.error;
    }
  }
  const writtenKey =
    plan.type === "copy"
      ? rawDocumentPayloadKey(owner, digest)
      : await writeRawSourcePayload({
          owner,
          window,
          data: plan.payload,
          contentType: row.sourceRawContentType ?? "application/octet-stream",
          storedKey,
          storedContentType: row.sourceRawContentType,
        });
  if (
    plan.type === "write" &&
    writtenKey !== rawSourcePayloadKey({ owner, data: plan.payload })
  ) {
    return panic("Raw layout wrote a payload under an unexpected key");
  }

  const moved = await scopedDb(async (tx) => {
    const current = (
      await tx
        .select({
          sourceRawS3Key: caseLawDecisions.sourceRawS3Key,
          redactedAt: caseLawDecisions.redactedAt,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, row.id))
        .for("update")
    ).at(0);
    if (current === undefined || current.redactedAt !== null) {
      // Erased or removed while this ran: what was just written under its
      // prefix may have landed after the erasure's sweep.
      await enqueueCaseLawRawSweepTx(tx, {
        decisionId: row.id,
        sourceId: row.sourceId,
        firstAttemptAt: new Date(),
        settleAfter: rawSweepSettleAfter(),
      });
      return false;
    }
    if (current.sourceRawS3Key !== storedKey) {
      // A writer moved the pointer; what this wrote sits under the
      // decision's own prefix, which its erasure reaches.
      return false;
    }
    // audit: skip — storage-layout maintenance; the row's content is unchanged
    await tx
      .update(caseLawDecisions)
      .set({
        sourceRawS3Key: writtenKey,
        updatedAt: sql`${caseLawDecisions.updatedAt}`,
      })
      .where(eq(caseLawDecisions.id, row.id));
    return true;
  });
  return {
    outcome: moved
      ? RAW_LAYOUT_ROW_OUTCOME.MIGRATED
      : RAW_LAYOUT_ROW_OUTCOME.OVERTAKEN,
    copies: copies.length,
  };
};

type ReportedRawLayoutOutcome =
  | typeof RAW_LAYOUT_ROW_OUTCOME.UNMOVABLE
  | typeof RAW_LAYOUT_ROW_OUTCOME.DANGLING
  | typeof RAW_LAYOUT_ROW_OUTCOME.RETRY;

export type RawLayoutPageResult = {
  /** Resume after this id; null once the table is walked to its end. */
  resumeAfter: SafeId<"caseLawDecision"> | null;
  counts: Record<RawLayoutRowOutcome, number> & { copies: number };
  /** Decisions the page reported, for the operator. */
  reported: {
    decisionId: SafeId<"caseLawDecision">;
    outcome: ReportedRawLayoutOutcome;
  }[];
};

type ReconcileRawLayoutPageOptions = {
  scopedDb: ScopedDb;
  cursor: SafeId<"caseLawDecision"> | null;
  limit: number;
  mode: RawLayoutMode;
  /** Restrict the walk to one source: the census before a legacy sweep. */
  sourceId?: SafeId<"caseLawSource">;
  readEveryPayload?: boolean;
};

/**
 * One page of the decisions table in id order. A decision that fails is
 * reported and passed, not waited on: one that fails every time would
 * otherwise hold every decision after it. The recurring walk wraps, so it
 * is tried again on the next pass, and the legacy sweep's census refuses
 * while any decision of its source still fails.
 */
export const reconcileCaseLawRawLayoutPage = async ({
  scopedDb,
  cursor,
  limit,
  mode,
  sourceId,
  readEveryPayload = false,
}: ReconcileRawLayoutPageOptions): Promise<RawLayoutPageResult> => {
  // Opened before the read that proves each decision live: see
  // `RAW_SOURCE_WRITE_WINDOW_MS`. A page that outlasts it stops at the
  // first write it refuses and resumes there.
  const window = openRawSourceWriteWindow();
  const rows = await scopedDb(
    async (tx) =>
      await tx
        .select({
          id: caseLawDecisions.id,
          sourceId: caseLawDecisions.sourceId,
          sourceRawS3Key: caseLawDecisions.sourceRawS3Key,
          sourceRawContentType: caseLawDecisions.sourceRawContentType,
          redactedAt: caseLawDecisions.redactedAt,
        })
        .from(caseLawDecisions)
        .where(
          and(
            cursor === null ? undefined : gt(caseLawDecisions.id, cursor),
            sourceId === undefined
              ? undefined
              : eq(caseLawDecisions.sourceId, sourceId),
          ),
        )
        .orderBy(asc(caseLawDecisions.id))
        .limit(limit),
  );
  const counts: RawLayoutPageResult["counts"] = {
    current: 0,
    migrated: 0,
    overtaken: 0,
    unmovable: 0,
    dangling: 0,
    retry: 0,
    copies: 0,
  };
  const reported: RawLayoutPageResult["reported"] = [];
  const reconcile = async (row: RawLayoutRow) =>
    await Result.tryPromise({
      try: async () =>
        await reconcileRawRow({
          scopedDb,
          row,
          mode,
          window,
          readEveryPayload,
        }),
      catch: (cause) => cause,
    });
  for (const row of rows) {
    // In id order, so the checkpoint can stop before a decision to retry.
    const reconciled = await reconcile(row);
    const { outcome, copies } = Result.isError(reconciled)
      ? { outcome: RAW_LAYOUT_ROW_OUTCOME.RETRY, copies: 0 }
      : reconciled.value;
    counts[outcome] += 1;
    counts.copies += copies;
    if (
      outcome === RAW_LAYOUT_ROW_OUTCOME.UNMOVABLE ||
      outcome === RAW_LAYOUT_ROW_OUTCOME.DANGLING ||
      outcome === RAW_LAYOUT_ROW_OUTCOME.RETRY
    ) {
      reported.push({ decisionId: row.id, outcome });
    }
  }
  return {
    resumeAfter: rows.length < limit ? null : (rows.at(-1)?.id ?? null),
    counts,
    reported,
  };
};
