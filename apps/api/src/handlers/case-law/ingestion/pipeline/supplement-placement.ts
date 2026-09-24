import { Result, panic } from "better-result";
import { and, eq, isNotNull, isNull } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { caseLawDecisionSupplements, caseLawDecisions } from "@/api/db/schema";
import type {
  DecisionSupplement,
  IngestionResult,
  StoredRawReadError,
} from "@/api/handlers/case-law/ingestion/adapter";
import { absorbComposedSupplementRows } from "@/api/handlers/case-law/ingestion/pipeline/composed-supplements";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import {
  PROCESS_DECISION_RETRY_REASON,
  PROCESS_DECISION_STATUS,
  SUPPLEMENT_RETRY_REASON,
  wrappedErrorDetail,
} from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import {
  RAW_OBJECT_COPY_TIMEOUT_MS,
  writeOwnedRawPayload,
} from "@/api/handlers/case-law/ingestion/pipeline/raw-payload";
import { SUPPLEMENT_JUDGMENT_READ_FAILED } from "@/api/handlers/case-law/ingestion/pipeline/supplement-types";
import type {
  ProcessSupplementOptions,
  ProcessSupplementResult,
  SupplementDisposition,
  SupplementStandaloneReason,
} from "@/api/handlers/case-law/ingestion/pipeline/supplement-types";
import { DECISION_REFRESH } from "@/api/handlers/case-law/ingestion/pipeline/types";
import {
  lockSupplementTarget,
  selectRulingsUnder,
  selectSupplementJudgment,
  supplementCanJoin,
} from "@/api/handlers/case-law/ingestion/supplement-composition";
import type { SupplementTargetKey } from "@/api/handlers/case-law/ingestion/supplement-composition";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { errorSystemFields } from "@/api/lib/errors/utils";
import {
  classifyCaseLawRawKey,
  deleteRawKeys,
  RAW_KEY_OWNERSHIP,
  RAW_SOURCE_FAMILY,
} from "@/api/lib/legal-search/raw-source-storage";
import type { RawSourceWriteWindow } from "@/api/lib/legal-search/raw-source-storage";
import { logger } from "@/api/lib/observability/logger";

/** One supplement's placement: its options and what they resolve to. */
export type SupplementPlacement = Required<
  Pick<ProcessSupplementOptions, "absorb" | "corpus">
> &
  Omit<ProcessSupplementOptions, "absorb" | "corpus"> & {
    /** The publisher's id for the supplement, as the adapter stated it. */
    sourceDocumentId: string;
    /** The supplement's document, sanitized. */
    document: IngestionResult;
    rawContentType: string;
    /**
     * Opened before the read that proves the judgment live, as a decision's
     * own write opens it; see `openRawSourceWriteWindow`.
     */
    rawWriteWindow: RawSourceWriteWindow;
  };

type SupplementJudgmentRow = {
  id: SafeId<"caseLawDecision">;
  redacted: boolean;
};

/** The supplement row's content, as this observation states it. */
export const supplementContent = (
  supplement: DecisionSupplement,
  document: IngestionResult,
) => ({
  kind: supplement.kind,
  caseNumber: document.caseNumber,
  court: document.court,
  language: document.language,
  latestDecisionDate: supplement.target.latestDecisionDate ?? null,
  judgmentDecisionTypes: [...supplement.target.decisionTypes],
  fulltext: document.fulltext ?? null,
  documentAst: document.documentAst,
  sourceHash: document.rawHash,
  sourceUrl: document.sourceUrl ?? null,
  documentUrl: document.documentUrl ?? null,
  metadata: document.metadata,
});

type PlaceSupplementOptions = {
  key: SupplementTargetKey;
  sourceId: SafeId<"caseLawSource">;
  sourceDocumentId: string;
  supplement: DecisionSupplement;
  observedAt: Date;
  content: ReturnType<typeof supplementContent>;
};

/**
 * Store the supplement under its docket's lock and choose the judgment it
 * joins: the one holding it already, unless a correction moved it off, or
 * the one ruling it now names. A supplement whose own row is erased, or
 * whose judgment is redacted, is dropped here.
 */
export const placeSupplementTx = async (
  tx: Transaction,
  {
    key,
    sourceId,
    sourceDocumentId,
    supplement,
    observedAt,
    content,
  }: PlaceSupplementOptions,
) => {
  await lockSupplementTarget(tx, key);
  const erasedOwn = (
    await tx
      .select({ id: caseLawDecisions.id })
      .from(caseLawDecisions)
      .where(
        and(
          eq(caseLawDecisions.sourceId, sourceId),
          eq(caseLawDecisions.sourceDocumentId, sourceDocumentId),
          isNotNull(caseLawDecisions.redactedAt),
        ),
      )
      .limit(1)
  ).at(0);
  if (erasedOwn !== undefined) {
    // audit: skip — background case-law ingestion; public case-law data
    await tx
      .delete(caseLawDecisionSupplements)
      .where(
        and(
          eq(caseLawDecisionSupplements.sourceId, sourceId),
          eq(caseLawDecisionSupplements.sourceDocumentId, sourceDocumentId),
        ),
      );
    return { type: "erased" as const, decisionId: erasedOwn.id };
  }
  // audit: skip — background case-law ingestion; public case-law data
  const [row] = await tx
    .insert(caseLawDecisionSupplements)
    .values({ sourceId, sourceDocumentId, observedAt, ...content })
    .onConflictDoUpdate({
      target: [
        caseLawDecisionSupplements.sourceId,
        caseLawDecisionSupplements.sourceDocumentId,
      ],
      set: { ...content, observedAt, updatedAt: new Date() },
    })
    .returning({
      decisionId: caseLawDecisionSupplements.decisionId,
      mergedSourceHash: caseLawDecisionSupplements.mergedSourceHash,
      sourceHash: caseLawDecisionSupplements.sourceHash,
    });
  if (row === undefined) {
    return panic("Supplement upsert returned no row");
  }
  const rulings = await selectRulingsUnder(tx, {
    key,
    decisionTypes: supplement.target.decisionTypes,
  });
  const selection = selectSupplementJudgment({
    target: supplement.target,
    candidates: rulings,
  });
  // A merged supplement stays with its judgment even where a ruling stored
  // since would now be picked: its text is in that judgment's document, and
  // moving it would leave the text there. Only a correction that leaves the
  // holder no longer a ruling it can join moves it.
  const holder =
    row.decisionId === null
      ? undefined
      : rulings.find(({ id }) => id === row.decisionId);
  const leavesHolder =
    row.decisionId !== null &&
    (holder === undefined ||
      !supplementCanJoin({ target: supplement.target, candidate: holder }));
  const judgment = ((): SupplementJudgmentRow | null => {
    if (leavesHolder) {
      return null;
    }
    if (row.decisionId !== null) {
      return { id: row.decisionId, redacted: holder?.redacted === true };
    }
    return selection.type === "judgment" ? selection.judgment : null;
  })();
  if (judgment?.redacted === true) {
    // A takedown covers the reasons of the decision it took down, as its
    // erasure removes those already merged: nothing of them is kept.
    // audit: skip — background case-law ingestion; public case-law data
    await tx
      .delete(caseLawDecisionSupplements)
      .where(
        and(
          eq(caseLawDecisionSupplements.sourceId, sourceId),
          eq(caseLawDecisionSupplements.sourceDocumentId, sourceDocumentId),
        ),
      );
  }
  return {
    type: "placed" as const,
    row,
    selection,
    leavesHolder,
    judgment,
  };
};

const supplementRawWriteFailed = (
  { sourceId, document }: SupplementPlacement,
  error: unknown,
): ProcessSupplementResult => {
  logger.error("case_law.ingestion.source_raw_write_failed", {
    sourceId,
    caseNumber: document.caseNumber,
    ...errorSystemFields(error),
    "error.detail": wrappedErrorDetail(error),
  });
  captureError(error, { sourceId, step: "processSupplement.raw" });
  return {
    status: PROCESS_DECISION_STATUS.RETRYABLE,
    reason: PROCESS_DECISION_RETRY_REASON.SOURCE_RAW_WRITE,
  };
};

/**
 * Point the supplement row at the payload its owner now holds. A payload
 * an earlier owner held for it, under a judgment's prefix, is deleted
 * first: a failure after that leaves the row pointing at nothing until the
 * next placement writes it again, never an object no pointer names. A
 * payload under the supplement's own standalone row is that row's, which
 * its absorption removes; one in the source-wide older layout is shared
 * and left to the legacy sweep.
 */
const pointSupplementRawAt = async (
  { scopedDb, sourceId, sourceDocumentId }: SupplementPlacement,
  next: { key: string; contentType: string | null } | null,
): Promise<void> => {
  const current = await scopedDb(async (tx) => ({
    pointer: (
      await tx
        .select({ key: caseLawDecisionSupplements.sourceRawS3Key })
        .from(caseLawDecisionSupplements)
        .where(
          and(
            eq(caseLawDecisionSupplements.sourceId, sourceId),
            eq(caseLawDecisionSupplements.sourceDocumentId, sourceDocumentId),
          ),
        )
        .limit(1)
    ).at(0),
    standaloneId: (
      await tx
        .select({ id: caseLawDecisions.id })
        .from(caseLawDecisions)
        .where(
          and(
            eq(caseLawDecisions.sourceId, sourceId),
            eq(caseLawDecisions.sourceDocumentId, sourceDocumentId),
          ),
        )
        .limit(1)
    ).at(0)?.id,
  }));
  if (current.pointer === undefined) {
    return;
  }
  const previous = current.pointer.key;
  if (previous === (next?.key ?? null)) {
    return;
  }
  if (
    previous !== null &&
    previous.startsWith(
      `${RAW_SOURCE_FAMILY.CASE_LAW}/raw/${sourceId}/documents/`,
    ) &&
    (current.standaloneId === undefined ||
      classifyCaseLawRawKey(previous, {
        sourceId,
        documentId: current.standaloneId,
      }) !== RAW_KEY_OWNERSHIP.OWN)
  ) {
    await deleteRawKeys(
      [previous],
      AbortSignal.timeout(RAW_OBJECT_COPY_TIMEOUT_MS),
    );
  }
  await scopedDb(async (tx) => {
    // audit: skip — background case-law ingestion; public case-law data
    await tx
      .update(caseLawDecisionSupplements)
      .set({
        sourceRawS3Key: next?.key ?? null,
        sourceRawContentType: next?.contentType ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(caseLawDecisionSupplements.sourceId, sourceId),
          eq(caseLawDecisionSupplements.sourceDocumentId, sourceDocumentId),
          previous === null
            ? isNull(caseLawDecisionSupplements.sourceRawS3Key)
            : eq(caseLawDecisionSupplements.sourceRawS3Key, previous),
        ),
      );
  });
};

/**
 * Store the payload under the judgment it joins and point the row at it.
 * An unchanged payload the row already records under that judgment writes
 * nothing.
 */
export const judgmentOwnsSupplementRaw = async (
  placement: SupplementPlacement,
  judgmentId: SafeId<"caseLawDecision">,
): Promise<ProcessSupplementResult | null> => {
  const {
    scopedDb,
    sourceId,
    sourceDocumentId,
    document,
    rawContentType,
    rawWriteWindow,
  } = placement;
  const stored = (
    await scopedDb((tx) =>
      tx
        .select({
          key: caseLawDecisionSupplements.sourceRawS3Key,
          contentType: caseLawDecisionSupplements.sourceRawContentType,
        })
        .from(caseLawDecisionSupplements)
        .where(
          and(
            eq(caseLawDecisionSupplements.sourceId, sourceId),
            eq(caseLawDecisionSupplements.sourceDocumentId, sourceDocumentId),
          ),
        )
        .limit(1),
    )
  ).at(0);
  const written = await Result.tryPromise({
    try: async () =>
      await writeOwnedRawPayload({
        result: document,
        sourceId,
        ownerId: judgmentId,
        contentType: rawContentType,
        storedKey: stored?.key ?? null,
        storedContentType: stored?.contentType ?? null,
        window: rawWriteWindow,
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(written)) {
    return supplementRawWriteFailed(placement, written.error);
  }
  if (Result.isError(written.value)) {
    return supplementRawWriteFailed(placement, written.value.error);
  }
  const writtenKey = written.value.value;
  if (writtenKey === undefined) {
    return null;
  }
  const pointed = await Result.tryPromise({
    try: async () =>
      await pointSupplementRawAt(placement, {
        key: writtenKey,
        contentType: rawContentType,
      }),
    catch: (cause) => cause,
  });
  return Result.isError(pointed)
    ? supplementRawWriteFailed(placement, pointed.error)
    : null;
};

/** Object storage did not answer for the judgment: try the placement again. */
export const supplementJudgmentReadFailed = (
  { sourceId, sourceDocumentId }: SupplementPlacement,
  judgmentId: SafeId<"caseLawDecision">,
  error: StoredRawReadError,
): ProcessSupplementResult => {
  logger.warn(SUPPLEMENT_JUDGMENT_READ_FAILED, {
    sourceId,
    judgmentId,
    sourceDocumentId,
    ...errorSystemFields(error.cause),
  });
  return {
    status: PROCESS_DECISION_STATUS.RETRYABLE,
    reason: SUPPLEMENT_RETRY_REASON.JUDGMENT_READ,
  };
};

/** Keep the supplement as a decision of its own, for `reason`. */
export const keepSupplementStandalone = async (
  placement: SupplementPlacement,
  reason: SupplementStandaloneReason,
): Promise<ProcessSupplementResult> => {
  const {
    scopedDb,
    sourceId,
    sourceDocumentId,
    supplement,
    document,
    observedAt,
    nextObservationOrder,
    corpus,
    polarityRules,
  } = placement;
  // The refresh check reads the publisher's hash, which a row stored before
  // supplements existed shares with this document; only its type differs,
  // and a type is what the check does not read.
  const storedType = (
    await scopedDb((tx) =>
      tx
        .select({ decisionType: caseLawDecisions.decisionType })
        .from(caseLawDecisions)
        .where(
          and(
            eq(caseLawDecisions.sourceId, sourceId),
            eq(caseLawDecisions.sourceDocumentId, sourceDocumentId),
          ),
        )
        .limit(1),
    )
  ).at(0);
  const written = await processDecision({
    input: supplement.document,
    sourceId,
    scopedDb,
    observedAt,
    observationOrder: await nextObservationOrder(),
    refresh:
      storedType !== undefined &&
      storedType.decisionType !== (document.decisionType ?? null)
        ? DECISION_REFRESH.ALWAYS
        : DECISION_REFRESH.WHEN_SOURCE_CHANGED,
    corpus,
    polarityRules,
  });
  if (written.status === PROCESS_DECISION_STATUS.RETRYABLE) {
    return written;
  }
  // Standalone, the supplement is its own row's: that row stored the
  // payload under its prefix, and the supplement names the same object.
  const own = (
    await scopedDb((tx) =>
      tx
        .select({
          key: caseLawDecisions.sourceRawS3Key,
          contentType: caseLawDecisions.sourceRawContentType,
          redactedAt: caseLawDecisions.redactedAt,
        })
        .from(caseLawDecisions)
        .where(
          and(
            eq(caseLawDecisions.sourceId, sourceId),
            eq(caseLawDecisions.sourceDocumentId, sourceDocumentId),
          ),
        )
        .limit(1),
    )
  ).at(0);
  const pointed = await Result.tryPromise({
    try: async () =>
      await pointSupplementRawAt(
        placement,
        own?.key === null || own?.key === undefined || own.redactedAt !== null
          ? null
          : { key: own.key, contentType: own.contentType },
      ),
    catch: (cause) => cause,
  });
  if (Result.isError(pointed)) {
    return supplementRawWriteFailed(placement, pointed.error);
  }
  return {
    status: PROCESS_DECISION_STATUS.COMPLETE,
    disposition: { type: "standalone", reason },
  };
};

/**
 * Take the supplement's standalone row, if any, out of the corpus behind
 * its judgment, then report `disposition`. A row left standing holds the
 * cursor: reporting the placement done would leave a second public copy.
 */
export const absorbSupplementIntoJudgment = async (
  {
    scopedDb,
    sourceId,
    supplement,
    sourceDocumentId,
    absorb,
  }: SupplementPlacement,
  judgmentId: SafeId<"caseLawDecision">,
  disposition: SupplementDisposition,
): Promise<ProcessSupplementResult> => {
  const outcome = await absorbComposedSupplementRows({
    scopedDb,
    sourceId,
    judgmentId,
    supplements: [{ kind: supplement.kind, sourceDocumentId }],
    absorb,
  });
  switch (outcome.type) {
    case "absorbed":
      return { status: PROCESS_DECISION_STATUS.COMPLETE, disposition };
    case "incomplete":
      return {
        status: PROCESS_DECISION_STATUS.RETRYABLE,
        reason: SUPPLEMENT_RETRY_REASON.ABSORB,
      };
    default: {
      outcome satisfies never;
      return panic(`Unhandled absorption: ${JSON.stringify(outcome)}`);
    }
  }
};
