import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import {
  CHAT_LOCAL_RUN_AWAITED_STEP_REFUSAL,
  CHAT_LOCAL_RUN_STEP_CONTENT_CONFLICT_CODE,
  CHAT_LOCAL_RUN_STEP_CONTENT_INVALID_CODE,
  CHAT_LOCAL_RUN_STEP_CONTENT_KINDS,
  CHAT_LOCAL_RUN_STEP_CONTENT_STATE,
  chatLocalRunStepContentCap,
  type ChatLocalRunStepContentKind,
  type ChatLocalRunStepContentStoredState,
  chatLocalRunStepKeySchema,
} from "@stll/api-contract/chat-local-run-step-content";
import {
  CHAT_LOCAL_RUN_STEP_MAX_BYTES,
  chatLocalRunImageType,
} from "@stll/api-contract/chat-local-run-step-output";
import { numberFromString } from "@stll/api-contract/http-input";
import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import type { SafeDb } from "@/api/db/safe-db";
import { chatThreads } from "@/api/db/schema";
import {
  deleteUploadedChatFiles,
  uploadUserFile,
  type UploadUserFileDependencies,
} from "@/api/handlers/chat/upload-files";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { fileSchema } from "@/api/lib/custom-schema";
import type { DesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import type {
  StepContentSettlement,
  StepWriter,
} from "@/api/lib/desktop-runner/step-contents";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { emitLocalRunStepContentMetric } from "@/api/lib/observability/request-metrics";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";

/**
 * One step's content, written for whoever may write it (`StepWriter`): the
 * run by its agent token while it is going, or the computer it ran on for a
 * step the run announced at its end. Both routes take the same request and
 * answer the same way; who the caller is, is each route's own.
 */

/** An image no step adopted could not be removed again; it stays until its thread goes. */
const UNADOPTED_IMAGE_SINK = failureSink({
  event: "chat.local_run_step_image_cleanup_failed",
  expected: [],
});

/** Room a multipart body needs beyond the content itself. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/** What a step content request carries, whoever sends it. */
export const STEP_CONTENT_REQUEST = {
  params: v.object({
    runId: v.pipe(v.string(), v.uuid()),
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
} as const;

export type StepContentControl = Pick<
  DesktopRunnerControl,
  "storeStepText" | "recordStepTooLarge" | "openStepImage" | "storeStepImage"
>;

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

type Refusal = Extract<StepContentSettlement, { type: "refused" }>["reason"];

/** The code a refused write answers with: the reason itself where it has one. */
const refusalCode = (reason: Refusal): string => {
  switch (reason) {
    case "other_run":
    case "different_content":
      return CHAT_LOCAL_RUN_STEP_CONTENT_CONFLICT_CODE;
    case CHAT_LOCAL_RUN_AWAITED_STEP_REFUSAL.notAwaited:
    case CHAT_LOCAL_RUN_AWAITED_STEP_REFUSAL.windowClosed:
    case CHAT_LOCAL_RUN_AWAITED_STEP_REFUSAL.otherComputer:
      return reason;
    default:
      reason satisfies never;
      return panic("Unhandled step content refusal");
  }
};

/**
 * A write that is refused for good: to a step that settled otherwise, by
 * another run, or after the run's end for a step that may not be sent.
 * Counted, since no honest sender makes one.
 */
const refusedWrite = (reason: Refusal) => {
  emitLocalRunStepContentMetric({ state: "refused", storedBytes: 0 });
  return Result.err(
    new HandlerError({
      status: 409,
      code: refusalCode(reason),
      message: "This step is not written",
    }),
  );
};

const settled = (state: ChatLocalRunStepContentStoredState) =>
  Result.ok({ state });

/** The whole of `bytes` as text, or `null` when it is not UTF-8. */
const utf8TextOf = (bytes: Uint8Array): string | null => {
  const decoded = Result.try(() =>
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
  );
  return Result.isError(decoded) ? null : decoded.value;
};

export type WriteStepContentOptions = {
  control: StepContentControl;
  writer: StepWriter;
  /** The member's own scoped connection, for the file an image is stored as. */
  safeDb: SafeDb;
  recordAuditEvent: AuditRecorder;
  uploads: UploadUserFileDependencies | undefined;
  stepKey: string;
  kind: ChatLocalRunStepContentKind;
  totalBytes: number;
  content: File | undefined;
};

type ImageOptions = Omit<WriteStepContentOptions, "kind" | "totalBytes"> & {
  file: File;
};

const writeImage = async ({
  control,
  writer,
  safeDb,
  recordAuditEvent,
  uploads,
  stepKey,
  file,
}: ImageOptions) =>
  await Result.gen(async function* () {
    const { organizationId, userId } = writer.owner;
    const bytes = new Uint8Array(await file.arrayBuffer());
    // The type is read from the bytes, never from the sender or the name; the
    // scan then holds the stored file to it.
    const mimeType = chatLocalRunImageType(bytes);
    if (mimeType === null) {
      return invalid("A step's image must be a PNG, JPEG, GIF or WebP image");
    }
    const sha256Hex = hashSha256Hex(bytes);
    const room = yield* Result.await(
      control.openStepImage({
        writer,
        stepKey,
        sha256Hex,
        totalBytes: bytes.byteLength,
      }),
    );
    if (room.type === "unknown_run") {
      return noSuchRun();
    }
    if (room.type === "refused") {
      return refusedWrite(room.reason);
    }
    if (room.type === "settled") {
      return settled(room.state);
    }
    const { threadId } = room;
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
      writer,
      stepKey,
      sha256Hex,
      userFileId: uploaded.id,
      sizeBytes: bytes.byteLength,
    });
    const adopted =
      stored.isOk() && stored.value.type === "settled" && stored.value.adopted;
    if (!adopted) {
      // The step did not take the file (it settled meanwhile, its run filled,
      // or the write failed), so nothing names it: remove it again.
      const removed = await deleteUploadedChatFiles({
        files: [uploaded],
        recordAuditEvent,
        safeDb,
        threadId,
        userId,
        workspaceId: thread.workspaceId,
      });
      if (Result.isError(removed)) {
        observeFailure(removed.error, { sink: UNADOPTED_IMAGE_SINK });
      }
    }
    if (stored.isErr()) {
      return Result.err(stored.error);
    }
    if (stored.value.type === "unknown_run") {
      return noSuchRun();
    }
    if (stored.value.type === "refused") {
      return refusedWrite(stored.value.reason);
    }
    emitLocalRunStepContentMetric({
      state: stored.value.state,
      storedBytes: stored.value.adopted ? bytes.byteLength : 0,
    });
    return settled(stored.value.state);
  });

/** How a text or size-only write settled, as its route answers it. */
const answered = (outcome: StepContentSettlement, storedBytes: number) => {
  if (outcome.type === "unknown_run") {
    return noSuchRun();
  }
  if (outcome.type === "refused") {
    return refusedWrite(outcome.reason);
  }
  emitLocalRunStepContentMetric({
    state: outcome.state,
    storedBytes:
      outcome.state === CHAT_LOCAL_RUN_STEP_CONTENT_STATE.stored
        ? storedBytes
        : 0,
  });
  return settled(outcome.state);
};

/**
 * Write one step's content for `writer`. A step settles once: whoever stored
 * it may send the same content again and is answered as before, and nothing
 * else writes it.
 */
export const writeStepContent = async (options: WriteStepContentOptions) =>
  await Result.gen(async function* () {
    const { control, writer, stepKey, kind, totalBytes, content } = options;
    const cap = chatLocalRunStepContentCap(kind);
    if (content === undefined) {
      if (kind !== "image" || totalBytes <= cap) {
        return invalid("Only an image past its cap is sent without content");
      }
      const recorded = yield* Result.await(
        control.recordStepTooLarge({ writer, stepKey, kind, totalBytes }),
      );
      return answered(recorded, 0);
    }
    if (content.size > cap || content.size > totalBytes) {
      return invalid("A step's content is larger than its kind keeps");
    }
    if (kind === "image") {
      // An image is stored whole or not at all, so what is sent is all of it.
      if (content.size !== totalBytes) {
        return invalid("An image's content is the whole image");
      }
      const image = yield* Result.await(
        writeImage({ ...options, file: content }),
      );
      return Result.ok(image);
    }
    const bytes = new Uint8Array(await content.arrayBuffer());
    const text = utf8TextOf(bytes);
    if (text === null) {
      return invalid("A step's text must be UTF-8");
    }
    const stored = yield* Result.await(
      control.storeStepText({
        writer,
        stepKey,
        kind,
        totalBytes,
        text,
        storedBytes: bytes.byteLength,
      }),
    );
    return answered(stored, bytes.byteLength);
  });
