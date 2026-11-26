import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { recordingTranscriptionRuns } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

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

type RecordingTranscriptionRunRow =
  typeof recordingTranscriptionRuns.$inferSelect;

const RUN_COLUMNS = {
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
} as const;

const UNPROJECTED_RUN_COLUMNS = [
  "entityFeatureGate", // RLS state is internal to the entity feature gate.
  "organizationId", // The session already scopes the organization.
  "workspaceId", // The authorized route already identifies the matter.
  "fileFieldId", // The run's recording is named by its entity.
  "entityVersionId", // The pinned version is the worker's input, not a status.
  "sourceFileId", // A stored-file id is internal to the worker's read.
  "sourceFileName", // The recording's entity already carries its name.
  "sourceMimeType", // Read by the worker to decode the recording.
  "outputFieldId", // The transcript is named by its entity.
  "requestedBy", // Run attribution is not part of the run's status.
  "modelRef", // Internal record of the model the run used.
  "startedAt", // Worker bookkeeping; createdAt and finishedAt bound the run.
] as const satisfies readonly (keyof RecordingTranscriptionRunRow)[];

type MissingRunColumn = UnprojectedColumns<
  RecordingTranscriptionRunRow,
  typeof RUN_COLUMNS,
  (typeof UNPROJECTED_RUN_COLUMNS)[number]
>;
type UnexpectedRunColumn = UnbackedProjectionKeys<
  RecordingTranscriptionRunRow,
  typeof RUN_COLUMNS,
  (typeof UNPROJECTED_RUN_COLUMNS)[number]
>;

true satisfies MissingRunColumn extends never ? true : never;
true satisfies UnexpectedRunColumn extends never ? true : never;

const readRecordingTranscriptionRun = createSafeHandler(
  config,
  async function* ({ params, safeDb, workspaceId }) {
    const runs = yield* Result.await(
      safeDb((tx) =>
        tx
          .select(RUN_COLUMNS)
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
