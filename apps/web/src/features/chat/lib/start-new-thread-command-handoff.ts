import type { QueryClient } from "@tanstack/react-query";
import { Result } from "better-result";

import type { ChatDraftAttachment } from "@/components/chat-editor-provider";
import type { ChatThreadOptionsContext } from "@/features/chat/chat-query-contract";
import { buildChatRequestMessage } from "@/features/chat/lib/build-chat-request-message";
import { chatThreadOptions } from "@/features/chat/queries";
import { setThreadActiveSkill } from "@/features/chat/thread-active-skill-store";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";

type StartNewThreadCommandHandoffArgs = {
  activeOrganizationId: string;
  /**
   * `getRunTarget` is required: a surface that starts a thread from its
   * composer hands over where that composer's turns run (its
   * `useChatComposerModels` getter), so the new thread starts there; one
   * whose turns always run on stella states `undefined`.
   */
  context: ChatThreadOptionsContext & {
    getRunTarget: ChatThreadOptionsContext["getRunTarget"];
  };
  files: ChatDraftAttachment[];
  html: string;
  queryClient: QueryClient;
  threadRef: ChatThreadRef;
};

/**
 * The new thread's data a hand-off starts its runtime on, carrying where the
 * first send runs. Until the server's read of the thread reflects that turn,
 * the destination page reads this entry, so it shows the target the turn
 * runs on rather than the draft's stored one (Auto on stella for a chat that
 * started on the member's last choice).
 */
export const readHandoffThread = async ({
  activeOrganizationId,
  context,
  queryClient,
  threadRef,
}: {
  activeOrganizationId: string;
  context: ChatThreadOptionsContext;
  queryClient: QueryClient;
  threadRef: ChatThreadRef;
}) => {
  const options = chatThreadOptions({
    activeOrganizationId,
    context,
    key: threadRef,
  });
  const data = await queryClient.query({ ...options, staleTime: "static" });
  const runTarget = context.getRunTarget?.();
  if (runTarget === undefined) {
    return data;
  }
  const seeded = { ...data, runTarget };
  queryClient.setQueryData(options.queryKey, seeded);
  return seeded;
};

/**
 * Starts `/new <message>` on a fresh thread before its destination mounts.
 *
 * The caller changes surface only after this returns, so a setup failure
 * bubbles to the editor and restores the original text and attachments.
 *
 * A skill in `context` is stored for the new thread first: until the
 * server has saved the thread, the destination page has no other record
 * of it.
 */
export const startNewThreadCommandHandoff = async ({
  activeOrganizationId,
  context,
  files,
  html,
  queryClient,
  threadRef,
}: StartNewThreadCommandHandoffArgs) => {
  const message = await buildChatRequestMessage({ files, html });
  if (message.isErr()) {
    return Result.err(message.error);
  }
  const activeSkill = context.getActiveSkill?.();
  if (activeSkill !== undefined) {
    setThreadActiveSkill(threadRef, activeSkill);
  }
  const [data, { acquireChatRuntime }] = await Promise.all([
    readHandoffThread({
      activeOrganizationId,
      context,
      queryClient,
      threadRef,
    }),
    import("@/features/chat/chat-runtime-registry"),
  ]);
  const chat = acquireChatRuntime({
    activeOrganizationId,
    context,
    data,
    key: threadRef,
    queryClient,
  });

  await chat.startRouteHandoffMessage(message.value, {
    timingSurface: "chat-thread",
  });
  return Result.ok();
};
