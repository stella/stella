import { queryOptions } from "@tanstack/react-query";
import { panic } from "better-result";
import * as v from "valibot";

import {
  type ChatLocalFilesUndo,
  chatLocalFilesUndoAnswerSchema,
  type ChatLocalFilesUndoRead,
  type ChatLocalFilesUndoRefusal,
} from "@stll/api-contract/chat-local-files-undo";

import { chatKeys } from "@/features/chat/chat-query-contract";
import { localFilesUndoPollMs } from "@/features/chat/local-files-undo.logic";
import { readClientClockMs } from "@/hooks/client-clock";
import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

export type LocalFilesUndoTurn = {
  activeOrganizationId: string;
  userId: string;
  threadId: string;
  turnId: string;
};

const undoRoute = ({
  threadId,
  turnId,
}: Pick<LocalFilesUndoTurn, "threadId" | "turnId">) =>
  api.chat
    .threads({ threadId: toSafeId<"chatThread">(threadId) })
    .turns({ turnId: toSafeId<"chatTurn">(turnId) })["local-files"].undo;

/**
 * Where the undo of a turn's file changes stands. While the cached undo may
 * still be answered, the read is asked again with a pause that grows with how
 * long the page has followed it (since `followedSince`, epoch ms) until it
 * settles. A failed read keeps the cached undo, so it is followed on.
 */
export const localFilesUndoOptions = (
  { activeOrganizationId, userId, threadId, turnId }: LocalFilesUndoTurn,
  followedSince: number,
) =>
  queryOptions({
    queryKey: chatKeys.localFilesUndo(
      activeOrganizationId,
      userId,
      threadId,
      turnId,
    ),
    queryFn: async ({ signal }): Promise<ChatLocalFilesUndoRead> =>
      unwrapApiResponse(
        await undoRoute({ threadId, turnId }).get({ fetch: { signal } }),
      ),
    refetchInterval: (query) =>
      localFilesUndoPollMs({
        read: query.state.data,
        pendingForMs: readClientClockMs() - followedSince,
      }),
  });

/** How a request to undo was answered: taken with its undo, or refused with the reason. */
export type LocalFilesUndoRequested =
  | { type: "accepted"; undo: ChatLocalFilesUndo }
  | { type: "refused"; reason: ChatLocalFilesUndoRefusal };

const REFUSED_STATUS = 409;

/**
 * Ask the turn's computer to undo the turn's file changes. A refusal (409)
 * is an answer, not a failure: its reason is shown on the turn.
 */
export const requestLocalFilesUndo = async (
  turn: LocalFilesUndoTurn,
): Promise<LocalFilesUndoRequested> => {
  const response = await undoRoute(turn).post();
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
