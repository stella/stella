import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { recordingTranscriptionRuns } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  contract: "patch",
  description: "Read a recording transcription run and its progress.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "document_processing",
    consumesServices: false,
  },
  params: workspaceParams({
    runId: resourceIdSchema("recordingTranscriptionRun"),
  }),
} satisfies WorkspaceHandlerConfig;

const readRecordingTranscriptionRun = createSafeHandler(
  config,
  async function* ({ params, safeDb, workspaceId }) {
    const runs = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: recordingTranscriptionRuns.id,
            entityId: recordingTranscriptionRuns.entityId,
            status: recordingTranscriptionRuns.status,
            errorCode: recordingTranscriptionRuns.errorCode,
            durationMs: recordingTranscriptionRuns.durationMs,
            transcribedMs: recordingTranscriptionRuns.transcribedMs,
            outputEntityId: recordingTranscriptionRuns.outputEntityId,
            outputFileName: recordingTranscriptionRuns.outputFileName,
            createdAt: recordingTranscriptionRuns.createdAt,
            finishedAt: recordingTranscriptionRuns.finishedAt,
          })
          .from(recordingTranscriptionRuns)
          .where(
            and(
              eq(recordingTranscriptionRuns.id, params.runId),
              eq(recordingTranscriptionRuns.workspaceId, workspaceId),
            ),
          )
          .limit(1),
      ),
    );
    const run = runs.at(0);
    if (!run) {
      return Result.err(
        new HandlerError({
          status: 404,
          code: "not_found",
          message: "Run not found",
        }),
      );
    }
    return Result.ok({ run });
  },
);

export default readRecordingTranscriptionRun;
