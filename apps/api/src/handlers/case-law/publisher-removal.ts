import { panic, Result } from "better-result";
import { eq, inArray } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCorpusUploadIntents,
  caseLawDecisionAliases,
  caseLawDecisions,
  caseLawDecisionSourceIdentities,
} from "@/api/db/schema";
import { runCitationGraphTransaction } from "@/api/handlers/case-law/citation-graph-transaction";
import { redactCaseLawDecisionWithSupplementHolders } from "@/api/handlers/case-law/ingestion/supplement-erasure";
import { removeCaseLawDerivedRowsTx } from "@/api/handlers/case-law/removal-stores";
import type { SafeId } from "@/api/lib/branded-types";
import { runDecisionWriteExtension } from "@/api/lib/case-law/decision-write-extension";
import { invalidateCaseLawRemovalSnapshotsTx } from "@/api/lib/case-law/removal-snapshots";
import { lockCaseLawDecisionRows } from "@/api/lib/db/aggregate-lock";
import { corpusProjectionRemovalIsPendingTx } from "@/api/lib/legal-search/corpus-index-projection-erasure-store";
import { eraseDecisionReconciliationPayloadsTx } from "@/api/lib/legal-search/reconciliation-store";
import type { RemovalEvidence } from "@/api/lib/legal-search/removal-evidence";

type PublisherRemovalOptions = {
  scopedDb: ScopedDb;
  decisionId: SafeId<"caseLawDecision">;
  evidence: RemovalEvidence;
  redact?: typeof redactCaseLawDecisionWithSupplementHolders;
};

/** Replay includes already fenced identities until their external erasure settles. */
export const removePublisherDecision = async ({
  scopedDb,
  decisionId,
  evidence,
  redact = redactCaseLawDecisionWithSupplementHolders,
}: PublisherRemovalOptions) => {
  const redacted = await redact({
    scopedDb,
    decisionId,
    evidence,
    leaseWaitMs: 0,
  });
  if (redacted.isErr()) {
    return redacted;
  }
  if (redacted.value.redaction.type === "superseded") {
    return Result.ok(redacted.value.redaction);
  }
  if (redacted.value.redaction.type === "not-found") {
    return Result.ok({ type: "removed" as const });
  }
  const projectionPending = await runCitationGraphTransaction(
    scopedDb,
    async (tx) => {
      const alias = (
        await tx
          .select({ id: caseLawDecisionAliases.canonicalDecisionId })
          .from(caseLawDecisionAliases)
          .where(eq(caseLawDecisionAliases.retiredDecisionId, decisionId))
          .limit(1)
      ).at(0);
      const canonicalId = alias?.id ?? decisionId;
      const aliases = await tx
        .select({ id: caseLawDecisionAliases.retiredDecisionId })
        .from(caseLawDecisionAliases)
        .where(eq(caseLawDecisionAliases.canonicalDecisionId, canonicalId));
      const ids = [canonicalId, ...aliases.map(({ id }) => id)];
      await lockCaseLawDecisionRows({ tx, decisionIds: ids });
      const rows = await tx
        .select({
          id: caseLawDecisions.id,
          sourceId: caseLawDecisions.sourceId,
          sourceDocumentId: caseLawDecisions.sourceDocumentId,
          country: caseLawDecisions.country,
          redactedAt: caseLawDecisions.redactedAt,
        })
        .from(caseLawDecisions)
        .where(inArray(caseLawDecisions.id, ids));
      const identities = await tx
        .select({
          sourceId: caseLawDecisionSourceIdentities.sourceId,
          sourceDocumentId: caseLawDecisionSourceIdentities.sourceDocumentId,
        })
        .from(caseLawDecisionSourceIdentities)
        .where(inArray(caseLawDecisionSourceIdentities.decisionId, ids));
      for (const row of rows) {
        if (row.redactedAt === null) {
          panic("Publisher removal requires a fenced decision");
        }
        if (row.sourceDocumentId !== null) {
          identities.push({
            sourceId: row.sourceId,
            sourceDocumentId: row.sourceDocumentId,
          });
        }
      }
      await eraseDecisionReconciliationPayloadsTx(tx, identities);
      // audit: skip — the canonical redaction records this removal in case_law_index_jobs.
      await tx
        .update(caseLawDecisions)
        .set({
          analysis: null,
          metadata: {},
          // The ordered source fingerprint remains a tombstone, not a new source observation.
          parsedSourceHash: null,
          parsedSourceHashVersion: null,
          parsedSourceRawS3Key: null,
        })
        .where(inArray(caseLawDecisions.id, ids));
      const upload = (
        await tx
          .select({ id: caseLawCorpusUploadIntents.id })
          .from(caseLawCorpusUploadIntents)
          .where(inArray(caseLawCorpusUploadIntents.decisionId, ids))
          .limit(1)
      ).at(0);
      for (const row of rows) {
        // db-await-in-loop: each fenced identity is scrubbed in stable row order.
        await removeCaseLawDerivedRowsTx(tx, row.id);
        // db-await-in-loop: snapshots are invalidated atomically with the removed inputs.
        await invalidateCaseLawRemovalSnapshotsTx(tx, {
          id: row.sourceId,
          country: row.country,
        });
        // db-await-in-loop: every canonical row mutation reaches its write extension.
        await runDecisionWriteExtension(tx, row.id);
      }
      return (
        upload !== undefined ||
        (await corpusProjectionRemovalIsPendingTx(tx, ids))
      );
    },
  );
  const { redaction, holders } = redacted.value;
  switch (redaction.type) {
    case "corpus-objects-remain":
      return Result.ok({ type: "pending" as const });
    case "redacted":
      return Result.ok({
        type:
          projectionPending ||
          redaction.legacyRaw === "pending" ||
          holders.some(({ type }) => type !== "recomposed")
            ? ("pending" as const)
            : ("removed" as const),
      });
    default:
      redaction satisfies never;
      return panic("Unhandled publisher removal outcome");
  }
};
