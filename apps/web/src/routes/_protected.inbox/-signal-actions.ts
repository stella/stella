import type { QueryClient } from "@tanstack/react-query";
import { Result } from "better-result";

import type { SuggestionKind } from "@stll/api-contract/signals";

import { createChatComposerDocument } from "@/components/chat-editor-markdown.logic";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { api } from "@/lib/api";
import {
  createChatDraftState,
  useChatDraftStore,
} from "@/lib/chat-draft-store";
import { createChatThreadId, getChatThreadKey } from "@/lib/chat-thread-ref";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { unwrapEden } from "@/lib/errors/api";
import { inboxKeys } from "@/lib/inbox/queries";
import type { InboxSignal } from "@/lib/inbox/queries";
import { toSafeId } from "@/lib/safe-id";

type SignalClient = ReturnType<typeof api.signals>;

const signalClient = (signalId: string): SignalClient =>
  api.signals({ signalId: toSafeId<"signal">(signalId) });

type InvalidateArgs = { queryClient: QueryClient; organizationId: string };

const invalidateInbox = async ({
  queryClient,
  organizationId,
}: InvalidateArgs) =>
  await queryClient.invalidateQueries({
    queryKey: inboxKeys.all(organizationId),
  });

export type SignalMutationArgs = InvalidateArgs & { signalId: string };

export const snoozeSignal = async ({
  signalId,
  until,
  ...invalidate
}: SignalMutationArgs & { until: Date }) =>
  Result.tryPromise(async () => {
    unwrapEden(
      await signalClient(signalId).snoozes.post({ until: until.toISOString() }),
    );
    await invalidateInbox(invalidate);
  });

export const dismissSignal = async ({
  signalId,
  reason,
  ...invalidate
}: SignalMutationArgs & { reason: string | null }) =>
  Result.tryPromise(async () => {
    unwrapEden(await signalClient(signalId).dismissals.post({ reason }));
    await invalidateInbox(invalidate);
  });

export const assignSignal = async ({
  signalId,
  assigneeUserId,
  ...invalidate
}: SignalMutationArgs & { assigneeUserId: string | null }) =>
  Result.tryPromise(async () => {
    unwrapEden(
      await signalClient(signalId).assignments.post({
        assigneeUserId:
          assigneeUserId === null ? null : toSafeId<"user">(assigneeUserId),
      }),
    );
    await invalidateInbox(invalidate);
  });

export const acceptSignal = async ({
  signalId,
  suggestionKind,
  ...invalidate
}: SignalMutationArgs & { suggestionKind: SuggestionKind }) =>
  Result.tryPromise(async () => {
    const accepted = unwrapEden(
      await signalClient(signalId).acceptances.post({ suggestionKind }),
    );
    await invalidateInbox(invalidate);
    return accepted;
  });

/**
 * Opens an inspector chat with the signal already in the composer. The
 * reader sends it, so the question can be edited before it costs a request.
 */
export const openSignalChat = (signal: InboxSignal, prompt: string): void => {
  const threadId = createChatThreadId();
  const scope: ChatThreadRef = signal.workspaceId
    ? { scope: "workspace", workspaceId: signal.workspaceId, threadId }
    : { scope: "global", threadId };
  useChatDraftStore
    .getState()
    .setDraft(
      getChatThreadKey(scope),
      createChatDraftState({ doc: createChatComposerDocument(prompt) }),
    );
  useInspectorTabsStore.getState().openChat({
    id: threadId,
    label: signal.title,
    ...(signal.workspaceId
      ? {
          workspaceId: signal.workspaceId,
          contextMatterIds: [signal.workspaceId],
        }
      : {}),
  });
};
