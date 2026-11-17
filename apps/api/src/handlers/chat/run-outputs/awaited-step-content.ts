import { Result } from "better-result";
import * as v from "valibot";

import { chatLocalRunStepContentUploadedSchema } from "@stll/api-contract/chat-local-run-step-content";
import { DESKTOP_RUNNER_DESKTOP_ID_HEADER } from "@stll/api-contract/desktop-runner";
import { Temporal } from "@stll/time";

import { safeDbFromScoped } from "@/api/db/safe-db";
import type { UploadUserFileDependencies } from "@/api/handlers/chat/upload-files";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { getDesktopRunnerControl } from "@/api/lib/desktop-runner/runtime";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import {
  STEP_CONTENT_REQUEST,
  type StepContentControl,
  writeStepContent,
} from "./step-content-write";

const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "upload_mechanics" },
  cache: { kind: "none" },
  params: STEP_CONTENT_REQUEST.params,
  query: STEP_CONTENT_REQUEST.query,
  body: STEP_CONTENT_REQUEST.body,
  requestBodyMaxBytes: STEP_CONTENT_REQUEST.requestBodyMaxBytes,
  response: safePublicHandlerResponseSchemasWithStatusText(
    chatLocalRunStepContentUploadedSchema,
  ),
} satisfies PublicHandlerConfig;

type AwaitedStepContentDependencies = {
  authorizeAccount?: typeof authorizeDesktopAccount;
  control?: () => StepContentControl;
  uploads?: UploadUserFileDependencies;
  /** The moment a write is judged at; the system's by default. */
  now?: () => Date;
};

const desktopIdSchema = v.pipe(v.string(), v.uuid());

/**
 * Stores a step a run announced, at its end, that it still had to send. The
 * run is over and its token with it, so the caller is the computer: its
 * linked account's credential with a proof by the device key. The store
 * holds the write to the installation and key the run ran on, to a step that
 * run announced and that is still awaited, inside the time such a step has;
 * anything else is refused for good, with the reason as its code.
 */
export const createStoreAwaitedStepContent = (
  dependencies: AwaitedStepContentDependencies = {},
) => {
  const authorizeAccount =
    dependencies.authorizeAccount ?? authorizeDesktopAccount;
  return createSafeBoundedPublicHandler(
    config,
    async function* ({
      request,
      body: { content },
      params: { runId, stepKey },
      query: { kind, totalBytes },
    }) {
      const desktopId = v.safeParse(
        desktopIdSchema,
        request.headers.get(DESKTOP_RUNNER_DESKTOP_ID_HEADER),
      );
      if (!desktopId.success) {
        return Result.err(
          new HandlerError({
            status: 400,
            code: "validation_error",
            message: "The request names no installation",
          }),
        );
      }
      const { consumedProof, organizationId, scopedDb, userId } =
        yield* Result.await(authorizeAccount(request));
      const written = yield* Result.await(
        writeStepContent({
          control:
            dependencies.control?.() ?? getDesktopRunnerControl().control,
          writer: {
            type: "computer",
            owner: { userId, organizationId },
            runId,
            desktopId: desktopId.output,
            deviceJkt: consumedProof.proof.thumbprint,
            now:
              dependencies.now?.() ??
              new Date(Temporal.Now.instant().epochMilliseconds),
          },
          safeDb: safeDbFromScoped(scopedDb),
          recordAuditEvent: createAuditRecorder({
            organizationId,
            workspaceId: null,
            userId,
            request,
            server: null,
          }),
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
};

const storeAwaitedStepContent = createStoreAwaitedStepContent();

declareAggregateMutation(storeAwaitedStepContent, {
  type: "independent",
  reason:
    "Settles one awaited step's content row, and for an image one immutable file row with its audit event and storage object, against the run's own storage counters; it changes no aggregate's ordered state.",
});

export default storeAwaitedStepContent;
