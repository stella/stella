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
 * Idempotent and re-entrant: an absorbed row absorbs to itself, and a run
 * that stopped between the withdrawal and the row write finishes on the
 * next call. Should the supplement lose its judgment again, the supplement's
 * next ingest writes the row as a decision and every one of these reverts.
 */

import { panic, Result } from "better-result";
import { and, eq, ne, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCitations,
  caseLawDecisionIdentifiers,
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
import type { DatabaseError } from "@/api/lib/errors/tagged-errors";
import type { DecisionSupplementKind } from "@/api/lib/legal-search/decision-supplement-kind";
import { metadataMarkedListingOnly } from "@/api/lib/legal-search/partial-observation-sql";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Pipeline-owned metadata key naming the judgment a standalone supplement
 * row was absorbed into. A later observation of the supplement as a decision
 * replaces the metadata and with it this key.
 */
export const ABSORBED_INTO_METADATA_KEY = "_stellaAbsorbedInto";

export type AbsorbStandaloneSupplementRowOutcome =
  /** No decision row carries the supplement's id: nothing stands beside it. */
  | { type: "absent" }
  /** The row is absorbed into the judgment, now or by an earlier call. */
  | { type: "absorbed"; decisionId: SafeId<"caseLawDecision"> }
  /** A redaction is a takedown and stays exactly as it is. */
  | { type: "redacted"; decisionId: SafeId<"caseLawDecision"> }
  /** A corpus object outlived its delete; the row keeps its document. */
  | { type: "withdraw-incomplete"; decisionId: SafeId<"caseLawDecision"> };

type AbsorbStandaloneSupplementRowOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  kind: DecisionSupplementKind;
  sourceDocumentId: string;
  judgmentId: SafeId<"caseLawDecision">;
  /** Test seam; production withdraws through the corpus stores. */
  withdraw?: typeof withdrawCaseLawDecisionDocument;
};

const absorbedInto = (
  metadata: Record<string, unknown> | null,
): string | undefined => {
  const marker = metadata?.[ABSORBED_INTO_METADATA_KEY];
  return isRecord(marker) && typeof marker["decisionId"] === "string"
    ? marker["decisionId"]
    : undefined;
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
          metadata: caseLawDecisions.metadata,
          contentHash: caseLawDecisions.contentHash,
          citationKey: caseLawDecisions.citationKey,
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
    absorbedInto(row.metadata) === judgmentId &&
    row.contentHash === null &&
    row.citationKey === null
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
        metadata: sql`jsonb_set(${metadataMarkedListingOnly(caseLawDecisions.metadata)}, ${sql.raw(`'{${ABSORBED_INTO_METADATA_KEY}}'`)}, jsonb_build_object('decisionId', ${judgmentId}::text, 'kind', ${kind}::text))`,
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
