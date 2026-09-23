/**
 * The latest verification of each of several documents, in one read: a
 * matter's document list shows every document's status at once, and one
 * request per document is the round trip this avoids.
 */

import { Result } from "better-result";
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
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
    "Read the latest list verification of each named document file (entity " +
    "id and file field id), in one call: its status, failure code, the list " +
    "it checked against, when it started and finished, and claim counts per " +
    "verdict state. A file never verified is absent from the answer. Earlier " +
    "runs are in lists.verifications.list.",
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "capability", reason: "document_processing" },
  body: t.Object({
    documents: t.Array(
      t.Object(
        { entityId: tSafeId("entity"), fileFieldId: tSafeId("field") },
        { additionalProperties: false },
      ),
      {
        minItems: 1,
        maxItems: VERIFICATION_LIMITS.LATEST_READ_DOCUMENTS_MAX,
        uniqueItems: true,
      },
    ),
  }),
} satisfies WorkspaceHandlerConfig;

const readLatestVerifications = createSafeHandler(
  config,
  async function* ({ body: { documents }, safeDb, workspaceId }) {
    // A run belongs to one file of a document, so two files of one document
    // each have their own latest run.
    const entityIds = [...new Set(documents.map((doc) => doc.entityId))];
    const namedFiles = or(
      ...documents.map((doc) =>
        and(
          eq(legalListVerificationRuns.entityId, doc.entityId),
          eq(legalListVerificationRuns.fileFieldId, doc.fileFieldId),
        ),
      ),
    );
    const runs = yield* Result.await(
      safeDb(async (tx) => {
        // Newest run per file: DISTINCT ON walks the document index
        // `(workspace_id, entity_id, file_field_id, created_at DESC)` once
        // per named file.
        const latest = await tx
          .selectDistinctOn(
            [
              legalListVerificationRuns.entityId,
              legalListVerificationRuns.fileFieldId,
            ],
            { ...RUN_SUMMARY_COLUMNS },
          )
          .from(legalListVerificationRuns)
          .where(
            and(
              eq(legalListVerificationRuns.workspaceId, workspaceId),
              inArray(legalListVerificationRuns.entityId, entityIds),
              namedFiles,
            ),
          )
          .orderBy(
            asc(legalListVerificationRuns.entityId),
            asc(legalListVerificationRuns.fileFieldId),
            desc(legalListVerificationRuns.createdAt),
            desc(legalListVerificationRuns.id),
          )
          .limit(documents.length);
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
