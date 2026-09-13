import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { pdfAnonymizationRuns } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description: "Read a PDF anonymization run and its verified output status.",
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "internal", reason: "document_processing" },
  params: workspaceParams({ runId: tSafeId("pdfAnonymizationRun") }),
} satisfies HandlerConfig;

const readPdfAnonymizationRun = createSafeHandler(
  config,
  async function* ({ params, safeDb, workspaceId }) {
    const runs = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: pdfAnonymizationRuns.id,
            status: pdfAnonymizationRuns.status,
            errorCode: pdfAnonymizationRuns.errorCode,
            pageCount: pdfAnonymizationRuns.pageCount,
            detectionCount: pdfAnonymizationRuns.detectionCount,
            certificate: pdfAnonymizationRuns.certificate,
            outputEntityId: pdfAnonymizationRuns.outputEntityId,
            outputFieldId: pdfAnonymizationRuns.outputFieldId,
            outputFileName: pdfAnonymizationRuns.outputFileName,
            createdAt: pdfAnonymizationRuns.createdAt,
            startedAt: pdfAnonymizationRuns.startedAt,
            finishedAt: pdfAnonymizationRuns.finishedAt,
          })
          .from(pdfAnonymizationRuns)
          .where(
            and(
              eq(pdfAnonymizationRuns.id, params.runId),
              eq(pdfAnonymizationRuns.workspaceId, workspaceId),
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

export default readPdfAnonymizationRun;
