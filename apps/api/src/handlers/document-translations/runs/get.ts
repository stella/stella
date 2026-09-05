import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { documentTranslationRuns } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description: "Read a document translation run and its progress.",
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "capability", reason: "document_processing" },
  params: workspaceParams({ runId: tSafeId("documentTranslationRun") }),
} satisfies HandlerConfig;

const readDocumentTranslationRun = createSafeHandler(
  config,
  async function* ({ params, safeDb, workspaceId }) {
    const runs = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: documentTranslationRuns.id,
            status: documentTranslationRuns.status,
            errorCode: documentTranslationRuns.errorCode,
            output: documentTranslationRuns.output,
            engine: documentTranslationRuns.engine,
            total: documentTranslationRuns.total,
            completed: documentTranslationRuns.completed,
            warnings: documentTranslationRuns.warnings,
            outputEntityId: documentTranslationRuns.outputEntityId,
            outputFieldId: documentTranslationRuns.outputFieldId,
            outputFileName: documentTranslationRuns.outputFileName,
            createdAt: documentTranslationRuns.createdAt,
            startedAt: documentTranslationRuns.startedAt,
            finishedAt: documentTranslationRuns.finishedAt,
          })
          .from(documentTranslationRuns)
          .where(
            and(
              eq(documentTranslationRuns.id, params.runId),
              eq(documentTranslationRuns.workspaceId, workspaceId),
            ),
          )
          .limit(1),
      ),
    );
    const run = runs.at(0);
    if (!run) {
      return Result.err(
        new HandlerError({ status: 404, message: "Run not found" }),
      );
    }
    return Result.ok({ run });
  },
);

export default readDocumentTranslationRun;
