import { Result } from "better-result";

import type { UploadUserFileDependencies } from "@/api/handlers/chat/upload-files";
import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { getDesktopRunnerControl } from "@/api/lib/desktop-runner/runtime";

import {
  STEP_CONTENT_REQUEST,
  type StepContentControl,
  writeStepContent,
} from "./step-content-write";
import { type RunCallerDependencies, verifyRunCaller } from "./upload";

type StepContentDependencies = RunCallerDependencies & {
  control?: () => StepContentControl;
  uploads?: UploadUserFileDependencies;
};

/**
 * Stores what one step of a local run produced, for the run's own agent
 * token, while the run is going. A step settles once: the run that stored it
 * may send the same content again and is answered as before, and nothing
 * else writes it.
 */
export const createStoreRunStepContent = (
  dependencies: StepContentDependencies = {},
) =>
  createSafeTokenHandler(
    {
      contract: "patch",
      accountAccess: ACCOUNT_ACCESS.sandbox,
      contentDelivery: {
        type: "none",
        reason:
          "Stores what a run's step produced; it answers only how the step settled.",
      },
      mcp: { type: "internal", reason: "upload_mechanics" },
      params: STEP_CONTENT_REQUEST.params,
      query: STEP_CONTENT_REQUEST.query,
      body: STEP_CONTENT_REQUEST.body,
      requestBodyMaxBytes: STEP_CONTENT_REQUEST.requestBodyMaxBytes,
    },
    verifyRunCaller(dependencies),
    async function* ({
      body: { content },
      caller: { organizationId, recordAuditEvent, safeDb, userId },
      params: { runId, stepKey },
      query: { kind, totalBytes },
    }) {
      const written = yield* Result.await(
        writeStepContent({
          control:
            dependencies.control?.() ?? getDesktopRunnerControl().control,
          writer: { type: "run", owner: { userId, organizationId }, runId },
          safeDb,
          recordAuditEvent,
          uploads: dependencies.uploads,
          stepKey,
          kind,
          totalBytes,
          content,
        }),
      );
      return Result.ok(written);
    },
  );

const storeRunStepContent = createStoreRunStepContent();

declareAggregateMutation(storeRunStepContent, {
  type: "independent",
  reason:
    "Writes one step's content row, and for an image one immutable file row with its audit event and storage object, against the run's own storage counters; it changes no aggregate's ordered state.",
});

export default storeRunStepContent;
