import { Result } from "better-result";

import type { SuggestionKind } from "@stll/api-contract/signals";

import { createChatComposerDocument } from "@/components/chat-editor-markdown.logic";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import {
  INBOX_SIGNAL_VIEW,
  inboxSignalTabId,
} from "@/features/inbox/signal-inspector.logic";
import { api } from "@/lib/api";
import {
  createChatDraftState,
  useChatDraftStore,
} from "@/lib/chat-draft-store";
import { createChatThreadId, getChatThreadKey } from "@/lib/chat-thread-ref";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { unwrapApiResponse } from "@/lib/errors/api";
import { useIdempotentSubmit } from "@/lib/idempotency/use-idempotent-submit";
import type { IdempotentRequest } from "@/lib/idempotency/use-idempotent-submit";
import type { InboxSignal } from "@/lib/inbox/queries";
import { toSafeId } from "@/lib/safe-id";

type SignalClient = ReturnType<typeof api.signals>;

const signalClient = (signalId: string): SignalClient =>
  api.signals({ signalId: toSafeId<"signal">(signalId) });

type SignalMutationArgs = { signalId: string };

export type ClientSignalAcceptanceResult = {
  type: "workspace";
  workspaceId: string;
};

const snoozeSignal = async (
  { signalId, until }: SignalMutationArgs & { until: Date },
  request: IdempotentRequest,
) =>
  Result.tryPromise(async () => {
    unwrapApiResponse(
      await signalClient(signalId).snoozes.post(
        { until: until.toISOString() },
        request,
      ),
    );
  });

const dismissSignal = async (
  { signalId, reason }: SignalMutationArgs & { reason: string | null },
  request: IdempotentRequest,
) =>
  Result.tryPromise(async () => {
    unwrapApiResponse(
      await signalClient(signalId).dismissals.post({ reason }, request),
    );
  });

const assignSignal = async (
  {
    signalId,
    assigneeUserId,
  }: SignalMutationArgs & { assigneeUserId: string | null },
  request: IdempotentRequest,
) =>
  Result.tryPromise(async () => {
    unwrapApiResponse(
      await signalClient(signalId).assignments.post(
        {
          assigneeUserId:
            assigneeUserId === null ? null : toSafeId<"user">(assigneeUserId),
        },
        request,
      ),
    );
  });

const acceptSignal = async (
  {
    signalId,
    suggestionKind,
    result,
  }: SignalMutationArgs & {
    suggestionKind: SuggestionKind;
    result?: ClientSignalAcceptanceResult;
  },
  request: IdempotentRequest,
) =>
  Result.tryPromise(async () => {
    const accepted = unwrapApiResponse(
      await signalClient(signalId).acceptances.post(
        {
          suggestionKind,
          ...(result
            ? {
                result: {
                  type: result.type,
                  workspaceId: toSafeId<"workspace">(result.workspaceId),
                },
              }
            : {}),
        },
        request,
      ),
    );
    return accepted;
  });

export const useIdempotentSignalActions = () => {
  const submit = useIdempotentSubmit();
  return {
    snoozeSignal: async (body: Parameters<typeof snoozeSignal>[0]) =>
      await submit.run({
        operation: `signal-snooze:${body.signalId}`,
        body,
        send: snoozeSignal,
      }),
    dismissSignal: async (body: Parameters<typeof dismissSignal>[0]) =>
      await submit.run({
        operation: `signal-dismiss:${body.signalId}`,
        body,
        send: dismissSignal,
      }),
    assignSignal: async (body: Parameters<typeof assignSignal>[0]) =>
      await submit.run({
        operation: `signal-assign:${body.signalId}`,
        body,
        send: assignSignal,
      }),
    acceptSignal: async (body: Parameters<typeof acceptSignal>[0]) =>
      await submit.run({
        operation: `signal-accept:${body.signalId}`,
        body,
        send: acceptSignal,
      }),
  };
};

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

export const openSignalEvidence = ({ id, title }: InboxSignal) => {
  useInspectorTabsStore.getState().openView({
    type: INBOX_SIGNAL_VIEW,
    id: inboxSignalTabId(id),
    label: title,
    payload: { signalId: id },
  });
};
