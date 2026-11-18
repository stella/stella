import type { Result } from "better-result";
import * as v from "valibot";

import {
  CHAT_LIMIT_RESET_ACTIONS,
  type ChatLimitResetAction,
} from "@stll/api-contract/chat-limit-reminder";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { requestApi } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";

/**
 * What the person asked to happen when the usage limit that stopped their
 * chat's turn on their computer resets: the chat continues by itself, or they
 * are told. The server reads the time off the stopped turn. The routes are
 * the web's (`apps/web/src/features/chat/chat-limit-reminder.ts`).
 */
const reminderSchema = v.union([
  v.object({ remindAt: v.null() }),
  v.object({
    remindAt: v.pipe(v.string(), v.isoTimestamp()),
    onReset: v.picklist(CHAT_LIMIT_RESET_ACTIONS),
  }),
]);

export type ChatLimitReminder = v.InferOutput<typeof reminderSchema>;

type ReminderRequest = {
  readonly fetch: Fetch;
  /** The thread's matter; the server refuses a matter's thread without it. */
  readonly matterId: string | undefined;
  readonly source: AccessTokenSource;
  readonly threadId: string;
};

const reminderPath = ({
  matterId,
  threadId,
}: Pick<ReminderRequest, "matterId" | "threadId">) =>
  `/v1/chat/threads/${encodeURIComponent(threadId)}/limit-reminder${
    matterId === undefined ? "" : `?workspaceId=${encodeURIComponent(matterId)}`
  }`;

export const readChatLimitReminder = async ({
  fetch,
  source,
  ...thread
}: ReminderRequest): Promise<Result<ChatLimitReminder, ApiError>> =>
  await requestApi({
    fetch,
    path: reminderPath(thread),
    schema: reminderSchema,
    source,
  });

/** Ask for `onReset` on the thread's stopped turn; asking again is a no-op. */
export const setChatLimitReminder = async ({
  fetch,
  onReset,
  source,
  ...thread
}: ReminderRequest & {
  readonly onReset: ChatLimitResetAction;
}): Promise<Result<ChatLimitReminder, ApiError>> =>
  await requestApi({
    fetch,
    method: "PUT",
    path: reminderPath(thread),
    body: { onReset },
    schema: reminderSchema,
    source,
  });

export const cancelChatLimitReminder = async ({
  fetch,
  source,
  ...thread
}: ReminderRequest): Promise<Result<ChatLimitReminder, ApiError>> =>
  await requestApi({
    fetch,
    method: "DELETE",
    path: reminderPath(thread),
    schema: reminderSchema,
    source,
  });

/**
 * When the usage limit that stopped a stored answer's turn resets, read from
 * the answer's metadata as the web reads it; undefined for any other answer.
 */
const limitOutcomeSchema = v.looseObject({
  turnOutcome: v.looseObject({
    type: v.literal("failed"),
    error: v.literal("local_runner_limit_reached"),
    limitResetsAt: v.pipe(v.string(), v.isoTimestamp()),
  }),
});

export const storedLimitResetsAt = (metadata: unknown): string | undefined => {
  const parsed = v.safeParse(limitOutcomeSchema, metadata);
  return parsed.success ? parsed.output.turnOutcome.limitResetsAt : undefined;
};
