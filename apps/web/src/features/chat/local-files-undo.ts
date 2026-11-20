import { queryOptions } from "@tanstack/react-query";
import { panic } from "better-result";
import * as v from "valibot";

import {
  chatLocalFilesUndoAnswerSchema,
  type ChatLocalFilesUndoRead,
} from "@stll/api-contract/chat-local-files-undo";

import { chatKeys } from "@/features/chat/chat-query-contract";
import {
  localFilesUndoPollMs,
  type LocalFilesUndoRequested,
} from "@/features/chat/local-files-undo.logic";
import { readClientClockMs } from "@/hooks/client-clock";
import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import { resourceQueryOptions } from "@/lib/workspace-realtime";

/** The member's sent message whose later file changes an edit may undo. */
export type LocalFilesUndoMessage = {
  activeOrganizationId: string;
  userId: string;
  threadId: string;
  messageId: string;
};

const undoRoute = ({
  threadId,
  messageId,
}: Pick<LocalFilesUndoMessage, "threadId" | "messageId">) =>
  api.chat
    .threads({ threadId: toSafeId<"chatThread">(threadId) })
    .messages({ messageId: toSafeId<"chatMessage">(messageId) })["local-files"]
    .undo;

/**
 * What editing the chat from the message does on the member's computer, and
 * the undo of its file changes. While the undo may still be answered, or a
 * turn of the thread still runs, the read is asked again with a pause that
 * grows with how long the form has followed it (since `followedSince`, epoch
 * ms). `follow: false` while the form follows the undo itself, as it sends.
 */
export const localFilesUndoOptions = (
  { activeOrganizationId, userId, threadId, messageId }: LocalFilesUndoMessage,
  { followedSince, follow }: { followedSince: number; follow: boolean },
) =>
  resourceQueryOptions(
    queryOptions({
      queryKey: chatKeys.localFilesUndo(
        activeOrganizationId,
        userId,
        threadId,
        messageId,
      ),
      queryFn: async ({ signal }): Promise<ChatLocalFilesUndoRead> =>
        unwrapApiResponse(
          await undoRoute({ threadId, messageId }).get({ fetch: { signal } }),
        ),
      refetchInterval: (query) =>
        follow &&
        localFilesUndoPollMs({
          read: query.state.data,
          pendingForMs: readClientClockMs() - followedSince,
        }),
    }),
    // Read when an edit form opens and followed by its own poll; no
    // resource event names an undo.
    { type: "independent" },
  );

const REFUSED_STATUS = 409;

/**
 * Ask the computer to undo the file changes made since the message. A
 * refusal (409) is an answer, not a failure: the edit form shows its reason.
 */
export const requestLocalFilesUndo = async (
  message: LocalFilesUndoMessage,
): Promise<LocalFilesUndoRequested> => {
  const response = await undoRoute(message).post();
  if (response.error?.status === REFUSED_STATUS) {
    const answer = v.safeParse(
      chatLocalFilesUndoAnswerSchema,
      response.error.value,
    );
    if (answer.success && answer.output.status === "refused") {
      return { type: "refused", reason: answer.output.reason };
    }
  }
  // Any other failure is the mutation's error.
  const answer = unwrapApiResponse(response);
  switch (answer.status) {
    case "accepted":
      return { type: "accepted", undo: answer.undo };
    case "refused":
      return { type: "refused", reason: answer.reason };
    default:
      answer satisfies never;
      return panic("Unhandled local files undo answer");
  }
};
