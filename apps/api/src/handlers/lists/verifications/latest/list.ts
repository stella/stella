/**
 * The latest verification of each of several documents, in one read: a
 * matter's document list shows every document's status at once, and one
 * request per document is the round trip this avoids.
 */

import { Result } from "better-result";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import { legalListClaims, legalListVerificationRuns } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { VERIFICATION_LIMITS } from "@/api/lib/lists/verification/contract";
import {
  CLAIM_COUNT_COLUMNS,
  RUN_SUMMARY_COLUMNS,
  serializeRunSummary,
} from "@/api/lib/lists/verification/run-summary";

const config = {
  description:
    "Read the latest list verification of each named document, in one call: " +
    "its status, failure code, the list it checked against, when it started " +
    "and finished, and claim counts per verdict state. A document never " +
    "verified is absent from the answer. Earlier runs are in " +
    "lists.verifications.list.",
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "capability", reason: "document_processing" },
  body: t.Object({
    entityIds: t.Array(tSafeId("entity"), {
      minItems: 1,
      maxItems: VERIFICATION_LIMITS.LATEST_READ_DOCUMENTS_MAX,
      uniqueItems: true,
    }),
  }),
} satisfies WorkspaceHandlerConfig;

const readLatestVerifications = createSafeHandler(
  config,
  async function* ({ body: { entityIds }, safeDb, workspaceId }) {
    const runs = yield* Result.await(
      safeDb(async (tx) => {
        // Newest run per document: DISTINCT ON walks the document index
        // `(workspace_id, entity_id, …, created_at DESC)` once per entity.
        const latest = await tx
          .selectDistinctOn([legalListVerificationRuns.entityId], {
            ...RUN_SUMMARY_COLUMNS,
          })
          .from(legalListVerificationRuns)
          .where(
            and(
              eq(legalListVerificationRuns.workspaceId, workspaceId),
              inArray(legalListVerificationRuns.entityId, entityIds),
            ),
          )
          .orderBy(
            asc(legalListVerificationRuns.entityId),
            desc(legalListVerificationRuns.createdAt),
            desc(legalListVerificationRuns.id),
          )
          .limit(entityIds.length);
        if (latest.length === 0) {
          return [];
        }
        const counts = await tx
          .select({ runId: legalListClaims.runId, ...CLAIM_COUNT_COLUMNS })
          .from(legalListClaims)
          .where(
            and(
              eq(legalListClaims.workspaceId, workspaceId),
              inArray(
                legalListClaims.runId,
                latest.map((run) => run.id),
              ),
            ),
          )
          .groupBy(legalListClaims.runId)
          .limit(latest.length);
        const countsByRun = new Map(counts.map((row) => [row.runId, row]));
        return latest.map((run) => {
          const count = countsByRun.get(run.id);
          return serializeRunSummary({
            ...run,
            supported: count?.supported ?? 0,
            tension: count?.tension ?? 0,
            contradicted: count?.contradicted ?? 0,
            nocover: count?.nocover ?? 0,
            notverifiable: count?.notverifiable ?? 0,
            recordconflict: count?.recordconflict ?? 0,
          });
        });
      }),
    );
    return Result.ok({ runs });
  },
);

export default readLatestVerifications;
