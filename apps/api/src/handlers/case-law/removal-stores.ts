import { panic } from "better-result";
import { eq, or } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  caseLawCitationDoctrineReviews,
  caseLawCitationReviews,
  caseLawCitations,
  caseLawDecisionCitationStats,
  caseLawDecisionCitationStatsState,
  caseLawDecisionIdentifiers,
  caseLawDecisionJudges,
  caseLawProvisionCitations,
  caseLawStatuteCitationMemberships,
} from "@/api/db/schema";
import { invalidateRemovedCitationAuthorityTx } from "@/api/handlers/case-law/citation-authority";
import type { SafeId } from "@/api/lib/branded-types";

/** Retained records refer to the fenced identity; they cannot republish it. */
type RemovalStore =
  | { type: "tombstone"; owner: string }
  | { type: "removed-by-owner"; owner: string }
  | {
      type: "remove";
      erase: (
        tx: Transaction,
        id: SafeId<"caseLawDecision">,
      ) => Promise<unknown>;
    };

/** The erasure owner executes every removable entry under its decision fence. */
export const CASE_LAW_REMOVAL_STORES = {
  case_law_decisions: { type: "tombstone", owner: "erasure" },
  case_law_decision_identifiers: {
    type: "remove",
    erase: async (tx, id) =>
      // audit: skip — derived rows belong to the canonical redaction audit.
      await tx
        .delete(caseLawDecisionIdentifiers)
        .where(eq(caseLawDecisionIdentifiers.decisionId, id)),
  },
  case_law_decision_judges: {
    type: "remove",
    erase: async (tx, id) =>
      // audit: skip — derived rows belong to the canonical redaction audit.
      await tx
        .delete(caseLawDecisionJudges)
        .where(eq(caseLawDecisionJudges.decisionId, id)),
  },
  citation_authority: {
    type: "remove",
    erase: invalidateRemovedCitationAuthorityTx,
  },
  case_law_citations: {
    type: "remove",
    erase: async (tx, id) =>
      // audit: skip — derived rows belong to the canonical redaction audit.
      await tx
        .delete(caseLawCitations)
        .where(
          or(
            eq(caseLawCitations.citingDecisionId, id),
            eq(caseLawCitations.citedDecisionId, id),
          ),
        ),
  },
  case_law_provision_citations: {
    type: "remove",
    erase: async (tx, id) =>
      // audit: skip — derived rows belong to the canonical redaction audit.
      await tx
        .delete(caseLawProvisionCitations)
        .where(eq(caseLawProvisionCitations.decisionId, id)),
  },
  case_law_statute_citation_memberships: {
    type: "remove",
    erase: async (tx, id) =>
      // audit: skip — derived rows belong to the canonical redaction audit.
      await tx
        .delete(caseLawStatuteCitationMemberships)
        .where(eq(caseLawStatuteCitationMemberships.decisionId, id)),
  },
  case_law_citation_reviews: {
    type: "remove",
    erase: async (tx, id) =>
      // audit: skip — derived rows belong to the canonical redaction audit.
      await tx
        .delete(caseLawCitationReviews)
        .where(eq(caseLawCitationReviews.citingDecisionId, id)),
  },
  case_law_citation_doctrine_reviews: {
    type: "remove",
    erase: async (tx, id) =>
      // audit: skip — derived rows belong to the canonical redaction audit.
      await tx
        .delete(caseLawCitationDoctrineReviews)
        .where(eq(caseLawCitationDoctrineReviews.citingDecisionId, id)),
  },
  case_law_provision_extractions: {
    type: "tombstone",
    owner: "provision-extraction lifecycle trigger",
  },
  case_law_decision_citation_stats: {
    type: "remove",
    erase: async (tx, id) =>
      // audit: skip — derived rows belong to the canonical redaction audit.
      await tx
        .delete(caseLawDecisionCitationStats)
        .where(eq(caseLawDecisionCitationStats.decisionId, id)),
  },
  case_law_decision_citation_stats_state: {
    type: "remove",
    erase: async (tx, id) =>
      // audit: skip — derived rows belong to the canonical redaction audit.
      await tx
        .delete(caseLawDecisionCitationStatsState)
        .where(eq(caseLawDecisionCitationStatsState.decisionId, id)),
  },
  case_law_decision_aliases: {
    type: "tombstone",
    owner: "erasure alias fence",
  },
  case_law_decision_alias_moved_identities: {
    type: "tombstone",
    owner: "erasure alias fence",
  },
  case_law_decision_source_identities: {
    type: "tombstone",
    owner: "erasure raw pointer cleanup",
  },
  case_law_decision_supplements: {
    type: "removed-by-owner",
    owner: "erasure supplement cleanup",
  },
  case_law_search_documents: {
    type: "removed-by-owner",
    owner: "removeDecisionFromIndex",
  },
  case_law_search_document_preview_passages: {
    type: "removed-by-owner",
    owner: "search document cascade",
  },
  case_law_search_backfill_failures: {
    type: "removed-by-owner",
    owner: "removeDecisionFromIndex",
  },
  case_law_analysis_failures: {
    type: "tombstone",
    owner: "public decision fence; reader-scoped diagnostics",
  },
  case_law_index_jobs: { type: "tombstone", owner: "erasure audit" },
  case_law_corpus_upload_intents: {
    type: "removed-by-owner",
    owner: "erasure upload cancellation and cleanup",
  },
  case_law_corpus_pack_refs: {
    type: "removed-by-owner",
    owner: "corpus pointer triggers",
  },
  case_law_corpus_tombstones: {
    type: "tombstone",
    owner: "corpus tombstone writer",
  },
  case_law_raw_sweeps: { type: "tombstone", owner: "raw sweep owner" },
  corpus_objects: { type: "tombstone", owner: "eraseCorpusObjects" },
  raw_objects: { type: "removed-by-owner", owner: "sweepCaseLawRawDecision" },
  corpus_index_projection_states: {
    type: "tombstone",
    owner: "projection erasure settlement",
  },
  corpus_index_projection_intents: {
    type: "tombstone",
    owner: "projection erasure settlement",
  },
  corpus_index: {
    type: "tombstone",
    owner: "synchronizeLockedCorpusProjectionDesiredStateTx",
  },
  case_law_browse_facet_counts: {
    type: "removed-by-owner",
    owner: "invalidateCaseLawRemovalSnapshotsTx",
  },
  case_law_source_arrivals: {
    type: "removed-by-owner",
    owner: "invalidateCaseLawRemovalSnapshotsTx",
  },
  case_law_sitemap_country_generations: {
    type: "tombstone",
    owner: "country generation invalidation",
  },
  case_law_sitemap_shards: {
    type: "removed-by-owner",
    owner: "invalidateCaseLawRemovalSnapshotsTx",
  },
  case_law_sitemap_shard_counts: {
    type: "removed-by-owner",
    owner: "invalidateCaseLawRemovalSnapshotsTx",
  },
  case_law_coverage_summaries: {
    type: "removed-by-owner",
    owner: "invalidateCaseLawRemovalSnapshotsTx",
  },
  case_law_reconciliation_items: {
    type: "removed-by-owner",
    owner: "eraseDecisionReconciliationPayloadsTx",
  },
  case_law_sources: {
    type: "tombstone",
    owner: "invalidateCaseLawRemovalSnapshotsTx",
  },
  case_law_statute_citation_counts: {
    type: "removed-by-owner",
    owner: "statute membership delete triggers",
  },
} as const satisfies Record<string, RemovalStore>;

export const removeCaseLawDerivedRowsTx = async (
  tx: Transaction,
  decisionId: SafeId<"caseLawDecision">,
) => {
  for (const store of Object.values(CASE_LAW_REMOVAL_STORES)) {
    switch (store.type) {
      case "remove":
        // db-await-in-loop: fixed store order preserves trigger and row-lock order.
        await store.erase(tx, decisionId);
        break;
      case "removed-by-owner":
      case "tombstone":
        break;
      default:
        store satisfies never;
        panic("Unhandled case-law removal store");
    }
  }
};
