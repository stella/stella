/**
 * Take a supplement's standalone decision row out of the corpus once its
 * judgment holds it.
 *
 * A supplement is stored as a decision of its own while no judgment matches
 * it (so its text stays readable), and every row SAOS reasons were stored as
 * before supplements existed is one too. When the judgment composes the
 * supplement, that row is the same text standing beside it: a second search
 * hit, a second holder of the judgment's docket that leaves citations of the
 * judgment ambiguous, and a second copy of every citation the reasons make.
 *
 * The row is absorbed rather than deleted. Deleting a decision cascades into
 * rows this worker cannot see, a workspace's links to the decision among
 * them, so the row keeps its id and publisher identity and loses what makes
 * it a decision: its document (withdrawn through the corpus stores), its
 * citations, its identifiers and docket key (so the resolver no longer
 * weighs it as a holder), its judges, and its publication (it carries the
 * unpublished marker every public read excludes). The metadata names the
 * judgment it was absorbed into.
 *
 * Its raw prefix goes too: the payload is the supplement's, which the
 * judgment now owns (`rehomeSupplementRaw`), and nothing names the row's
 * own copy once its pointer is cleared.
 *
 * Idempotent and re-entrant: an absorbed row absorbs to itself, and a run
 * that stopped between the withdrawal and the row write finishes on the
 * next call. Should the supplement lose its judgment again, the supplement's
 * next ingest writes the row as a decision and every one of these reverts.
 */

import { panic, Result } from "better-result";
import { and, eq, isNull, ne } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCitations,
  caseLawDecisionIdentifiers,
  caseLawDecisionSupplements,
  caseLawDecisions,
} from "@/api/db/schema";
import {
  lockCitationGraph,
  reopenCitationsForKeys,
  reopenCitationsResolvedTo,
} from "@/api/handlers/case-law/citation-resolution";
import { replaceDecisionJudges } from "@/api/handlers/case-law/judges/decision-judges";
import { withdrawCaseLawDecisionDocument } from "@/api/handlers/case-law/withdraw-document";
import type { SafeId } from "@/api/lib/branded-types";
import {
  decisionAbsorptionSql,
  metadataWithDecisionAbsorption,
  readDecisionAbsorption,
} from "@/api/lib/case-law/decision-absorption";
import type { DatabaseError } from "@/api/lib/errors/tagged-errors";
import type { DecisionSupplementKind } from "@/api/lib/legal-search/decision-supplement-kind";
import { metadataMarkedListingOnly } from "@/api/lib/legal-search/partial-observation-sql";
import {
  classifyCaseLawRawKey,
  copyRawObject,
  deleteRawKeys,
  eraseRawDocument,
  isUnmovableRawObjectError,
  openRawSourceWriteWindow,
  RAW_KEY_OWNERSHIP,
  RAW_SOURCE_FAMILY,
  rawDocumentPayloadKey,
} from "@/api/lib/legal-search/raw-source-storage";
import type { RawObjectCopyFailure } from "@/api/lib/legal-search/raw-source-storage";
import { headS3ObjectWithSignal } from "@/api/lib/s3";

/** Bound on the object-storage calls one supplement's raw move makes. */
const SUPPLEMENT_RAW_IO_TIMEOUT_MS = 60_000;

const SHA256_HEX = /^[0-9a-f]{64}$/u;

type RehomeSupplementRawOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  sourceDocumentId: string;
  judgmentId: SafeId<"caseLawDecision">;
};

/**
 * Put a merged supplement's stored payload under the judgment that holds it,
 * so the judgment's erasure reaches it by the judgment's own prefix.
 *
 * The object is copied under the same digest, the row's pointer moves
 * compare-and-set on the key it was read with, and a copy an earlier
 * judgment held is deleted: a correction that moved the supplement leaves
 * nothing of it under its former owner. A copy under the supplement's own
 * standalone row is removed with that row's absorption, and one in the
 * source-wide older layout is shared and left to the legacy sweep. A source
 * that is not stored cannot be copied now or later; the pointer is cleared,
 * and the supplement's next observation stores its payload again.
 */
export const rehomeSupplementRaw = async ({
  scopedDb,
  sourceId,
  sourceDocumentId,
  judgmentId,
}: RehomeSupplementRawOptions): Promise<Result<void, RawObjectCopyFailure>> => {
  // Opened before the read that proves the judgment live; see
  // `openRawSourceWriteWindow`.
  const window = openRawSourceWriteWindow();
  const read = await scopedDb(async (tx) => ({
    pointer: (
      await tx
        .select({
          key: caseLawDecisionSupplements.sourceRawS3Key,
          contentType: caseLawDecisionSupplements.sourceRawContentType,
        })
        .from(caseLawDecisionSupplements)
        .where(
          and(
            eq(caseLawDecisionSupplements.sourceId, sourceId),
            eq(caseLawDecisionSupplements.sourceDocumentId, sourceDocumentId),
            eq(caseLawDecisionSupplements.decisionId, judgmentId),
          ),
        )
        .limit(1)
    ).at(0),
    judgmentLive:
      (
        await tx
          .select({ id: caseLawDecisions.id })
          .from(caseLawDecisions)
          .where(
            and(
              eq(caseLawDecisions.id, judgmentId),
              isNull(caseLawDecisions.redactedAt),
            ),
          )
          .limit(1)
      ).length > 0,
    standaloneId: (
      await tx
        .select({ id: caseLawDecisions.id })
        .from(caseLawDecisions)
        .where(
          and(
            eq(caseLawDecisions.sourceId, sourceId),
            eq(caseLawDecisions.sourceDocumentId, sourceDocumentId),
            ne(caseLawDecisions.id, judgmentId),
          ),
        )
        .limit(1)
    ).at(0)?.id,
  }));
  const from = read.pointer?.key ?? null;
  if (from === null || !read.judgmentLive) {
    return Result.ok(undefined);
  }
  const owner = {
    family: RAW_SOURCE_FAMILY.CASE_LAW,
    sourceId,
    documentId: judgmentId,
  } as const;
  if (classifyCaseLawRawKey(from, owner) === RAW_KEY_OWNERSHIP.OWN) {
    return Result.ok(undefined);
  }
  const signal = AbortSignal.timeout(SUPPLEMENT_RAW_IO_TIMEOUT_MS);
  const movePointer = async (to: string | null): Promise<void> => {
    await scopedDb(async (tx) => {
      // audit: skip — storage-layout maintenance; the supplement is unchanged
      await tx
        .update(caseLawDecisionSupplements)
        .set({
          sourceRawS3Key: to,
          sourceRawContentType: to === null ? null : read.pointer?.contentType,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(caseLawDecisionSupplements.sourceId, sourceId),
            eq(caseLawDecisionSupplements.sourceDocumentId, sourceDocumentId),
            eq(caseLawDecisionSupplements.sourceRawS3Key, from),
          ),
        );
    });
  };
  const digest = from.slice(from.lastIndexOf("/") + 1);
  const head = SHA256_HEX.test(digest)
    ? await headS3ObjectWithSignal(from, signal)
    : null;
  const byteLength = head?.contentLength ?? null;
  if (byteLength === null) {
    await movePointer(null);
    return Result.ok(undefined);
  }
  const to = rawDocumentPayloadKey(owner, digest);
  const copied = await copyRawObject({
    copy: {
      fromKey: from,
      ref: {
        location: to,
        sha256: digest,
        contentType:
          read.pointer?.contentType ??
          head?.contentType ??
          "application/octet-stream",
        byteLength,
      },
    },
    window,
    signal,
  });
  if (Result.isError(copied)) {
    if (!isUnmovableRawObjectError(copied.error)) {
      return copied;
    }
    await movePointer(null);
    return Result.ok(undefined);
  }
  await movePointer(to);
  const formerJudgmentCopy =
    from.startsWith(
      `${RAW_SOURCE_FAMILY.CASE_LAW}/raw/${sourceId}/documents/`,
    ) &&
    (read.standaloneId === undefined ||
      classifyCaseLawRawKey(from, {
        sourceId,
        documentId: read.standaloneId,
      }) !== RAW_KEY_OWNERSHIP.OWN);
  if (formerJudgmentCopy) {
    await deleteRawKeys([from], signal);
  }
  return Result.ok(undefined);
};

export type AbsorbStandaloneSupplementRowOutcome =
  /** No decision row carries the supplement's id: nothing stands beside it. */
  | { type: "absent" }
  /** The row is absorbed into the judgment, now or by an earlier call. */
  | { type: "absorbed"; decisionId: SafeId<"caseLawDecision"> }
  /** A redaction is a takedown and stays exactly as it is. */
  | { type: "redacted"; decisionId: SafeId<"caseLawDecision"> }
  /** A corpus object outlived its delete; the row keeps its document. */
  | { type: "withdraw-incomplete"; decisionId: SafeId<"caseLawDecision"> }
  /** A raw object outlived its delete; the row keeps its raw pointer. */
  | {
      type: "raw-incomplete";
      decisionId: SafeId<"caseLawDecision">;
      error: unknown;
    };

type AbsorbStandaloneSupplementRowOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  kind: DecisionSupplementKind;
  sourceDocumentId: string;
  judgmentId: SafeId<"caseLawDecision">;
  /** Test seam; production withdraws through the corpus stores. */
  withdraw?: typeof withdrawCaseLawDecisionDocument;
};

export const absorbStandaloneSupplementRow = async ({
  scopedDb,
  sourceId,
  kind,
  sourceDocumentId,
  judgmentId,
  withdraw = withdrawCaseLawDecisionDocument,
}: AbsorbStandaloneSupplementRowOptions): Promise<
  Result<AbsorbStandaloneSupplementRowOutcome, DatabaseError>
> => {
  const row = (
    await scopedDb((tx) =>
      tx
        .select({
          id: caseLawDecisions.id,
          redactedAt: caseLawDecisions.redactedAt,
          absorption: decisionAbsorptionSql(caseLawDecisions.metadata),
          contentHash: caseLawDecisions.contentHash,
          citationKey: caseLawDecisions.citationKey,
          sourceRawS3Key: caseLawDecisions.sourceRawS3Key,
        })
        .from(caseLawDecisions)
        .where(
          and(
            eq(caseLawDecisions.sourceId, sourceId),
            eq(caseLawDecisions.sourceDocumentId, sourceDocumentId),
            ne(caseLawDecisions.id, judgmentId),
          ),
        )
        .limit(1),
    )
  ).at(0);
  if (row === undefined) {
    return Result.ok({ type: "absent" });
  }
  if (row.redactedAt !== null) {
    return Result.ok({ type: "redacted", decisionId: row.id });
  }
  if (
    readDecisionAbsorption(row.absorption)?.decisionId === judgmentId &&
    row.contentHash === null &&
    row.citationKey === null &&
    row.sourceRawS3Key === null
  ) {
    return Result.ok({ type: "absorbed", decisionId: row.id });
  }

  const withdrawn = await withdraw({
    decisionId: row.id,
    reason: `${kind} ${sourceDocumentId} absorbed into decision ${judgmentId}`,
    scopedDb,
  });
  if (Result.isError(withdrawn)) {
    return withdrawn;
  }
  switch (withdrawn.value.type) {
    case "not-found":
      return Result.ok({ type: "absent" });
    case "corpus-objects-remain":
      return Result.ok({ type: "withdraw-incomplete", decisionId: row.id });
    case "withdrawn":
      break;
    default: {
      withdrawn.value satisfies never;
      return panic(`Unhandled withdrawal: ${JSON.stringify(withdrawn.value)}`);
    }
  }

  // Deleted before the pointer is cleared, so a run that stops between the
  // two finds the pointer and deletes again.
  const rawErased = await Result.tryPromise({
    try: async () =>
      await eraseRawDocument({
        family: RAW_SOURCE_FAMILY.CASE_LAW,
        sourceId,
        documentId: row.id,
        signal: AbortSignal.timeout(SUPPLEMENT_RAW_IO_TIMEOUT_MS),
      }),
    catch: (cause) => cause,
  });
  const rawError = ((): unknown => {
    if (Result.isError(rawErased)) {
      return rawErased.error;
    }
    return Result.isError(rawErased.value) ? rawErased.value.error : null;
  })();
  if (rawError !== null) {
    return Result.ok({
      type: "raw-incomplete",
      decisionId: row.id,
      error: rawError,
    });
  }

  await scopedDb(async (tx) => {
    // The resolver takes the graph lock before citation rows; so does this.
    await lockCitationGraph(tx);
    const locked = (
      await tx
        .select({ citationKey: caseLawDecisions.citationKey })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, row.id))
        .for("update")
        .limit(1)
    ).at(0);
    if (locked === undefined) {
      return;
    }
    // audit: skip — background case-law ingestion; public case-law data
    await tx
      .delete(caseLawCitations)
      .where(eq(caseLawCitations.citingDecisionId, row.id));
    await reopenCitationsResolvedTo(tx, row.id);
    // audit: skip — background case-law ingestion; public case-law data
    await tx
      .delete(caseLawDecisionIdentifiers)
      .where(eq(caseLawDecisionIdentifiers.decisionId, row.id));
    await replaceDecisionJudges(tx, { decisionId: row.id, judges: [] });
    // audit: skip — background case-law ingestion; public case-law data
    await tx
      .update(caseLawDecisions)
      .set({
        citationKey: null,
        // Should the supplement lose its judgment, the write that makes this
        // row a decision again carries the same publisher hash; without one
        // stored, the refresh check cannot skip it.
        sourceHash: null,
        // Its prefix was deleted above; the payload is the judgment's now.
        sourceRawS3Key: null,
        sourceRawContentType: null,
        metadata: metadataWithDecisionAbsorption(
          metadataMarkedListingOnly(caseLawDecisions.metadata),
          { decisionId: judgmentId, kind, sourceDocumentId },
        ),
        updatedAt: new Date(),
      })
      .where(eq(caseLawDecisions.id, row.id));
    // Leaving the docket is what can make the judgment its only holder:
    // citations that gave up on the key as ambiguous are asked again.
    if (locked.citationKey !== null) {
      await reopenCitationsForKeys(tx, [locked.citationKey]);
    }
  });
  return Result.ok({ type: "absorbed", decisionId: row.id });
};
