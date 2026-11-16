// What a coding agent's step produced on the person's computer (a command's
// output, a change's diff, a subagent's conversation, an image it viewed),
// read from the API that stores it with the conversation, as the web reads
// it (`@stll/api-contract/chat-local-run-step-content`). A text comes one
// window at a time: the first when the step opens, each further one when
// the person asks for more.

import { Result } from "better-result";

import {
  CHAT_LOCAL_RUN_STEP_CONTENT_STATE,
  chatLocalRunStepContentSchema,
} from "@stll/api-contract/chat-local-run-step-content";
import {
  foldLocalRunStepOutput,
  LOCAL_RUN_STEP_OUTPUT_UNREAD,
  type LocalRunStepOutputView,
} from "@stll/api-contract/chat-local-run-step-content-view";
import { userFileIdFromUrl } from "@stll/api-contract/user-file-url";

import { SignedOutError } from "@/connection/errors";
import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { ApiRequestError, requestApi } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";

/**
 * How the phone loads a stored image: the API's address for the chat file,
 * which sends the image on to storage, and the token it takes.
 */
type StepImageSource = {
  readonly uri: string;
  readonly headers: { readonly Authorization: string };
};

/**
 * A step's content as far as it was read. `failed`: the last read did not
 * answer; what was read before it stays, and reading again continues it.
 */
export type StepContentRead =
  | {
      readonly type: "read";
      readonly view: LocalRunStepOutputView;
      readonly image: StepImageSource | null;
    }
  | {
      readonly type: "failed";
      readonly view: LocalRunStepOutputView;
      readonly image: StepImageSource | null;
      readonly error: ApiError;
    };

export const STEP_CONTENT_UNREAD: StepContentRead = {
  type: "read",
  view: LOCAL_RUN_STEP_OUTPUT_UNREAD,
  image: null,
};

/** Whether a text read so far stops short of what is stored. */
export const hasMoreStepText = (view: LocalRunStepOutputView): boolean =>
  view.status === "text" && view.readBytes < view.storedBytes;

/**
 * Where the next read starts: after the text read so far, or at the step's
 * start (the first read, and again for one still arriving or a read that
 * failed before anything answered).
 */
const nextStart = (view: LocalRunStepOutputView): number =>
  view.status === "text" && view.readBytes < view.storedBytes
    ? view.readBytes
    : 0;

export const stepContentPath = ({
  callId,
  start,
  threadId,
}: {
  readonly callId: string;
  readonly start: number;
  readonly threadId: string;
}) =>
  `/v1/chat/threads/${encodeURIComponent(threadId)}/local-run-steps/${encodeURIComponent(callId)}/content?start=${String(start)}`;

const userFileContentPath = (fileId: string) =>
  `/v1/user-files/${encodeURIComponent(fileId)}/content`;

/**
 * Whether a text is read whole in one go: a subagent's conversation shows
 * only whole entries, and one entry may be longer than a window, so it is
 * read to its end as the web reads it. A command's output or a diff is read
 * one window at a time.
 */
const readsWhole = (view: LocalRunStepOutputView): boolean =>
  view.status === "text" && view.kind === "conversation";

/**
 * The next read of a step, from where `read` leaves it (`nextStart`): one
 * window, or for a conversation every window to its end. A read that fails
 * keeps every window that answered before it.
 */
export const readStepContent = async ({
  callId,
  fetch,
  read,
  source,
  threadId,
}: {
  readonly callId: string;
  readonly fetch: Fetch;
  readonly read: StepContentRead;
  readonly source: AccessTokenSource;
  readonly threadId: string;
}): Promise<StepContentRead> => {
  let { view } = read;
  for (;;) {
    const content = await requestApi({
      fetch,
      path: stepContentPath({ callId, start: nextStart(view), threadId }),
      schema: chatLocalRunStepContentSchema,
      source,
    });
    if (Result.isError(content)) {
      return { type: "failed", view, image: read.image, error: content.error };
    }
    view = foldLocalRunStepOutput(view, content.value);
    if (
      content.value.state === CHAT_LOCAL_RUN_STEP_CONTENT_STATE.stored &&
      content.value.kind === "image"
    ) {
      const image = await stepImageSource({
        fileUrl: content.value.file.url,
        source,
      });
      // An image with no way to load it shows nothing it answered.
      return Result.isError(image)
        ? {
            type: "failed",
            view: read.view,
            image: read.image,
            error: image.error,
          }
        : { type: "read", view, image: image.value };
    }
    if (!readsWhole(view) || !hasMoreStepText(view)) {
      return { type: "read", view, image: null };
    }
  }
};

/** The address and token the phone loads a stored step's image with. */
const stepImageSource = async ({
  fileUrl,
  source,
}: {
  readonly fileUrl: string;
  readonly source: AccessTokenSource;
}): Promise<Result<StepImageSource, ApiError>> =>
  await Result.gen(async function* () {
    const fileId = userFileIdFromUrl(fileUrl);
    if (fileId === null) {
      return Result.err(
        new ApiRequestError({ message: "The step's image names no file" }),
      );
    }
    const token = yield* Result.await(source.accessToken());
    const session = source.session();
    if (session === undefined) {
      return Result.err(
        new SignedOutError({ message: "The session is no longer current" }),
      );
    }
    return Result.ok({
      uri: `${session.serverUrl}${userFileContentPath(fileId)}`,
      headers: { Authorization: `Bearer ${token}` },
    });
  });
