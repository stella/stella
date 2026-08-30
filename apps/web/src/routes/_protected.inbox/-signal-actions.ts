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
import type { InboxSignal } from "@/lib/inbox/queries";
import { toSafeId } from "@/lib/safe-id";

type SignalClient = ReturnType<typeof api.signals>;

const signalClient = (signalId: string): SignalClient =>
  api.signals({ signalId: toSafeId<"signal">(signalId) });

export type SignalMutationArgs = { signalId: string };

export type ClientSignalAcceptanceResult = {
  type: "workspace";
  workspaceId: string;
};

export const snoozeSignal = async ({
  signalId,
  until,
}: SignalMutationArgs & { until: Date }) =>
  Result.tryPromise(async () => {
    unwrapEden(
      await signalClient(signalId).snoozes.post({ until: until.toISOString() }),
    );
  });

export const dismissSignal = async ({
  signalId,
  reason,
}: SignalMutationArgs & { reason: string | null }) =>
  Result.tryPromise(async () => {
    unwrapEden(await signalClient(signalId).dismissals.post({ reason }));
  });

export const assignSignal = async ({
  signalId,
  assigneeUserId,
}: SignalMutationArgs & { assigneeUserId: string | null }) =>
  Result.tryPromise(async () => {
    unwrapEden(
      await signalClient(signalId).assignments.post({
        assigneeUserId:
          assigneeUserId === null ? null : toSafeId<"user">(assigneeUserId),
      }),
    );
  });

export const acceptSignal = async ({
  signalId,
  suggestionKind,
  result,
}: SignalMutationArgs & {
  suggestionKind: SuggestionKind;
  result?: ClientSignalAcceptanceResult;
}) =>
  Result.tryPromise(async () => {
    const accepted = unwrapEden(
      await signalClient(signalId).acceptances.post({
        suggestionKind,
        ...(result
          ? {
              result: {
                type: result.type,
                workspaceId: toSafeId<"workspace">(result.workspaceId),
              },
            }
          : {}),
      }),
    );
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
