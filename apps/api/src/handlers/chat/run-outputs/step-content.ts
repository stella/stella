import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import {
  CHAT_LOCAL_RUN_STEP_CONTENT_INVALID_CODE,
  CHAT_LOCAL_RUN_STEP_CONTENT_KINDS,
  CHAT_LOCAL_RUN_STEP_CONTENT_STATE,
  chatLocalRunStepContentCap,
  type ChatLocalRunStepContentStoredState,
  chatLocalRunStepKeySchema,
  type ChatLocalRunStepTextKind,
} from "@stll/api-contract/chat-local-run-step-content";
import {
  CHAT_LOCAL_RUN_STEP_MAX_BYTES,
  chatLocalRunImageType,
} from "@stll/api-contract/chat-local-run-step-output";
import { numberFromString } from "@stll/api-contract/http-input";

import { chatThreads } from "@/api/db/schema";
import {
  deleteUploadedChatFiles,
  uploadUserFile,
  type UploadUserFileDependencies,
} from "@/api/handlers/chat/upload-files";
import { captureError } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import { fileSchema } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import type { DesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import { getDesktopRunnerControl } from "@/api/lib/desktop-runner/runtime";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { emitLocalRunStepContentMetric } from "@/api/lib/observability/request-metrics";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";

import {
  type RunCallerDependencies,
  type RunOutputCaller,
  verifyRunCaller,
} from "./upload";

/** Room a multipart body needs beyond the content itself. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

const runIdSchema = v.pipe(v.string(), v.uuid());

type StepContentControl = Pick<
  DesktopRunnerControl,
  "storeStepText" | "recordStepTooLarge" | "openStepImage" | "storeStepImage"
>;

type StepContentDependencies = RunCallerDependencies & {
  control?: () => StepContentControl;
  uploads?: UploadUserFileDependencies;
};

const invalid = (message: string) =>
  Result.err(
    new HandlerError({
      status: 422,
      code: CHAT_LOCAL_RUN_STEP_CONTENT_INVALID_CODE,
      message,
    }),
  );

const noSuchRun = () =>
  Result.err(
    new HandlerError({
      status: 404,
      code: "not_found",
      message: "This run takes no content",
    }),
  );

const settled = (state: ChatLocalRunStepContentStoredState) =>
  Result.ok({ state });

/** The whole of `bytes` as text, or `null` when it is not UTF-8. */
const utf8TextOf = (bytes: Uint8Array): string | null => {
  const decoded = Result.try(() =>
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
  );
  return Result.isError(decoded) ? null : decoded.value;
};

type StoreTextOptions = {
  control: StepContentControl;
  caller: RunOutputCaller;
  runId: string;
  stepKey: string;
  kind: ChatLocalRunStepTextKind;
  totalBytes: number;
  bytes: Uint8Array;
};

const storeText = async ({
  control,
  caller,
  runId,
  stepKey,
  kind,
  totalBytes,
  bytes,
}: StoreTextOptions) =>
  await Result.gen(async function* () {
    const text = utf8TextOf(bytes);
    if (text === null) {
      return invalid("A step's text must be UTF-8");
    }
    const stored = yield* Result.await(
      control.storeStepText({
        owner: { userId: caller.userId, organizationId: caller.organizationId },
        runId,
        stepKey,
        kind,
        totalBytes,
        text,
        storedBytes: bytes.byteLength,
      }),
    );
    if (stored.type === "unknown_run") {
      return noSuchRun();
    }
    emitLocalRunStepContentMetric({
      state: stored.state,
      storedBytes:
        stored.state === CHAT_LOCAL_RUN_STEP_CONTENT_STATE.stored
          ? bytes.byteLength
          : 0,
    });
    return settled(stored.state);
  });

type StoreImageOptions = {
  control: StepContentControl;
  caller: RunOutputCaller;
  uploads: UploadUserFileDependencies | undefined;
  runId: string;
  stepKey: string;
  file: File;
};

const storeImage = async ({
  control,
  caller,
  uploads,
  runId,
  stepKey,
  file,
}: StoreImageOptions) =>
  await Result.gen(async function* () {
    const { organizationId, recordAuditEvent, safeDb, threadId, userId } =
      caller;
    const owner = { userId, organizationId };
    const bytes = new Uint8Array(await file.arrayBuffer());
    // The type is read from the bytes, never from the sender or the name; the
    // scan then holds the stored file to it.
    const mimeType = chatLocalRunImageType(bytes);
    if (mimeType === null) {
      return invalid("A step's image must be a PNG, JPEG, GIF or WebP image");
    }
    const room = yield* Result.await(
      control.openStepImage({
        owner,
        runId,
        stepKey,
        totalBytes: bytes.byteLength,
      }),
    );
    if (room.type === "unknown_run") {
      return noSuchRun();
    }
    if (room.type === "settled") {
      return settled(room.state);
    }
    const thread = yield* Result.await(
      safeDb(
        async (tx) =>
          await tx
            .select({ workspaceId: chatThreads.workspaceId })
            .from(chatThreads)
            .where(
              and(
                eq(chatThreads.id, threadId),
                eq(chatThreads.userId, userId),
                eq(chatThreads.organizationId, organizationId),
              ),
            )
            .limit(1)
            .then((rows) => rows.at(0) ?? null),
      ),
    );
    if (thread === null) {
      return noSuchRun();
    }
    const uploaded = yield* Result.await(
      uploadUserFile({
        ...(uploads === undefined ? {} : { dependencies: uploads }),
        file: { bytes, fileName: sanitizeFilename(file.name), mimeType },
        organizationId,
        recordAuditEvent,
        safeDb,
        threadId,
        userId,
        workspaceId: thread.workspaceId,
      }),
    );
    const stored = await control.storeStepImage({
      owner,
      runId,
      stepKey,
      userFileId: uploaded.id,
      sizeBytes: bytes.byteLength,
    });
    const adopted =
      stored.isOk() && stored.value.type === "settled" && stored.value.adopted;
    if (!adopted) {
      // The step did not take the file (it settled meanwhile, its run ended or
      // filled, or the write failed), so nothing names it: remove it again.
      const removed = await deleteUploadedChatFiles({
        files: [uploaded],
        recordAuditEvent,
        safeDb,
        threadId,
        userId,
        workspaceId: thread.workspaceId,
      });
      if (Result.isError(removed)) {
        captureError(
          removed.error,
          handlerErrorContext("chat.localRunStepContent.removeUnadoptedImage", {
            stage: "local-run-step-image-cleanup",
            userFileId: uploaded.id,
          }),
        );
      }
    }
    if (stored.isErr()) {
      return Result.err(stored.error);
    }
    if (stored.value.type === "unknown_run") {
      return noSuchRun();
    }
    emitLocalRunStepContentMetric({
      state: stored.value.state,
      storedBytes: stored.value.adopted ? bytes.byteLength : 0,
    });
    return settled(stored.value.state);
  });

/**
 * Stores what one step of a local run produced, for the run's own agent
 * token. The step's key makes the write repeatable: the same step sent again
 * replaces its text, and an image step keeps its first image.
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
      params: v.object({
        runId: runIdSchema,
        stepKey: chatLocalRunStepKeySchema,
      }),
      query: v.object({
        kind: v.picklist(CHAT_LOCAL_RUN_STEP_CONTENT_KINDS),
        /** How many bytes the step produced, sent or not. */
        totalBytes: numberFromString(
          v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
        ),
      }),
      body: v.strictObject({
        /** Absent only for an image past its cap, which sends its size alone. */
        content: v.optional(
          fileSchema({ maxBytes: CHAT_LOCAL_RUN_STEP_MAX_BYTES.image }),
        ),
      }),
      requestBodyMaxBytes:
        CHAT_LOCAL_RUN_STEP_MAX_BYTES.image + MULTIPART_OVERHEAD_BYTES,
    },
    verifyRunCaller(dependencies),
    async function* ({
      body: { content },
      caller,
      params: { runId, stepKey },
      query: { kind, totalBytes },
    }) {
      const control =
        dependencies.control?.() ?? getDesktopRunnerControl().control;
      const cap = chatLocalRunStepContentCap(kind);
      if (content === undefined) {
        if (kind !== "image" || totalBytes <= cap) {
          return invalid("Only an image past its cap is sent without content");
        }
        const recorded = yield* Result.await(
          control.recordStepTooLarge({
            owner: {
              userId: caller.userId,
              organizationId: caller.organizationId,
            },
            runId,
            stepKey,
            kind,
            totalBytes,
          }),
        );
        if (recorded.type === "unknown_run") {
          return noSuchRun();
        }
        emitLocalRunStepContentMetric({
          state: recorded.state,
          storedBytes: 0,
        });
        return settled(recorded.state);
      }
      if (content.size > cap || content.size > totalBytes) {
        return invalid("A step's content is larger than its kind keeps");
      }
      if (kind === "image") {
        const image = yield* Result.await(
          storeImage({
            control,
            caller,
            uploads: dependencies.uploads,
            runId,
            stepKey,
            file: content,
          }),
        );
        return Result.ok(image);
      }
      const text = yield* Result.await(
        storeText({
          control,
          caller,
          runId,
          stepKey,
          kind,
          totalBytes,
          bytes: new Uint8Array(await content.arrayBuffer()),
        }),
      );
      return Result.ok(text);
    },
  );

const storeRunStepContent = createStoreRunStepContent();

declareAggregateMutation(storeRunStepContent, {
  type: "independent",
  reason:
    "Writes one step's content row, and for an image one immutable file row with its audit event and storage object, against the run's own storage counters; it changes no aggregate's ordered state.",
});

export default storeRunStepContent;
