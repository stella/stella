import { Profiler, Suspense } from "react";
import type { ProfilerOnRenderCallback } from "react";

import {
  QueryClient,
  QueryClientProvider,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { render, waitFor, within } from "@testing-library/react";
import { panic } from "better-result";
import { IntlProvider } from "use-intl";

import { ChatEditorProvider } from "@/components/chat-editor-provider";
import { ChatApprovalContext } from "@/components/chat/chat-approval-context";
import { ChatMattersContext } from "@/components/chat/chat-matters-context";
import { ChatThreadMessages } from "@/components/chat/chat-thread-messages";
import { useChatSession } from "@/features/chat/hooks/use-chat-session";
import { useChatThreadRuntime } from "@/features/chat/hooks/use-chat-thread-runtime";
import { chatThreadOptions } from "@/features/chat/queries";
import messages from "@/i18n/langs/en.json";
import { AuthenticatedUserProvider } from "@/lib/authenticated-user-context";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { ChatThreadTestRouter } from "@/lib/chat-thread-test-router";
import { mcpConnectorsOptions } from "@/lib/knowledge/queries";
import { ensureRouteQueryData } from "@/lib/react-query";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";

// The thread page's chat, mounted in a test DOM: the page's own wiring
// (`chatThreadOptions`, `useChatThreadRuntime`, `useChatSession`,
// `ChatThreadMessages` and its cards) over whatever `fetch` the test
// installed. Load this module only once the DOM exists (a DOM test imports it
// dynamically after registering one).

export type ChatThreadDomSession = ReturnType<typeof useChatSession>;

/** What the page shows while a part of it is still loading. */
const SUSPENDED = "The page is loading";

/**
 * Whether a part of the page is still loading. Checked as a boolean because a
 * `waitFor` callback fails on every poll until the page settles, and a failed
 * matcher formats what it received: for a DOM node that is its whole
 * document, which costs about a second per poll.
 */
export const isThreadPageSuspended = (container: HTMLElement) =>
  within(container).queryByText(SUSPENDED) !== null;

const CHAT_THREAD_CONTEXT = { allowMissingThread: true } as const;

const threadRefOf = (threadId: string) =>
  ({ scope: "global", threadId: toChatThreadId(threadId) }) as const;

/** The thread query the page suspends on, keyed as `ChatThreadPage` keys it. */
const threadQueryOptions = (organizationId: string, threadId: string) =>
  chatThreadOptions({
    activeOrganizationId: organizationId,
    context: CHAT_THREAD_CONTEXT,
    key: threadRefOf(threadId),
  });

/** The thread page's chat, wired as `ChatThreadPage` wires it. */
const ChatThreadDomPage = ({
  onSession,
  organizationId,
  threadId,
}: {
  onSession: (session: ChatThreadDomSession) => void;
  organizationId: string;
  threadId: string;
}) => {
  const threadRef = threadRefOf(threadId);
  const { data } = useSuspenseQuery(
    threadQueryOptions(organizationId, threadId),
  );
  const chat = useChatThreadRuntime({
    activeOrganizationId: organizationId,
    context: CHAT_THREAD_CONTEXT,
    data,
    key: threadRef,
  });
  const session = useChatSession({
    chat,
    conversationId: threadId,
    initialOlderCursor: data.olderCursor,
    threadRef,
  });
  onSession(session);
  return (
    <ChatMattersContext
      value={{
        createDocumentMattersView: session.createDocumentMattersView,
      }}
    >
      <ChatApprovalContext
        value={{
          activeOrganizationId: organizationId,
          alwaysApprovedTools: session.alwaysApprovedTools,
          conversationApprovedTools: session.conversationApprovedTools,
          handleAllowInConversation: session.handleAllowInConversation,
          handleAlwaysAllow: session.handleAlwaysAllow,
          handleApprove: session.handleApprove,
          handleDeny: session.handleDeny,
          handleRequestSecret: session.handleRequestSecret,
          continueRequestSecret: session.continueRequestSecret,
          resolveSecretTarget: session.resolveSecretTarget,
          secretAvailabilityKey: session.secretAvailabilityKey,
        }}
      >
        {/* The selection bar quotes into the composer through the editor
            manager, as on the real page. */}
        <ChatEditorProvider>
          <ChatThreadMessages
            approvalPendingMessageId={session.approvalPendingMessageId}
            error={session.error}
            hasOlderMessages={session.olderCursor !== null}
            isGenerating={session.isGenerating}
            isLoadingOlder={session.isLoadingOlder}
            loadOlderError={session.loadOlderError}
            messages={session.messages}
            onAskUserEditAndRerun={session.handleAskUserEditAndRerun}
            onAskUserSubmit={session.handleAskUserSubmit}
            onCreateDocumentResolve={session.handleCreateDocumentResolve}
            onLoadOlder={session.loadOlder}
            onOpenCreateDocumentDraft={session.handleOpenCreateDocumentDraft}
            onOpenCreatedDocument={session.handleOpenCreatedDocument}
            onResend={session.resendLatestMessage}
            queuedMessageActions={{
              remove: session.removeQueuedMessage,
              sendNow: session.sendQueuedMessageNow,
            }}
            queuedMessages={session.queuedMessages}
            showThinkingIndicator
            streamdownComponents={session.streamdownComponents}
            threadRef={threadRef}
          />
        </ChatEditorProvider>
      </ChatApprovalContext>
    </ChatMattersContext>
  );
};

/**
 * A tab on thread `threadId`, loaded the way the page loads it. `onRender`
 * hears every commit of the page, as a `Profiler` at its root reports it.
 */
export const openChatThreadDomPage = async ({
  onRender,
  organizationId,
  threadId,
}: {
  onRender?: ProfilerOnRenderCallback | undefined;
  organizationId: string;
  threadId: string;
}) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const userId = "00000000-0000-7000-8000-00000000fffe";
  // Lists the chat reads beside the thread, answered as empty.
  queryClient.setQueryData(mcpConnectorsOptions(organizationId).queryKey, {
    canManageCustomConnectors: false,
    connectors: [],
    nativeTools: [],
  });
  queryClient.setQueryData(
    workspacesNavigationOptions({ organizationId, userId }).queryKey,
    { workspaces: [], features: { timeBilling: false } },
  );
  // The thread route's loader fills a cold thread query before the page
  // mounts, so the page renders its messages on first paint instead of
  // suspending on them.
  await ensureRouteQueryData(
    queryClient,
    threadQueryOptions(organizationId, threadId),
  );
  let session: ChatThreadDomSession | undefined;
  const view = render(
    <Profiler
      id="chat-thread-dom-page"
      onRender={onRender ?? (() => undefined)}
    >
      <ChatThreadTestRouter>
        <QueryClientProvider client={queryClient}>
          <IntlProvider locale="en" messages={messages} timeZone="UTC">
            <AuthenticatedUserProvider
              user={{
                activeOrganizationId: organizationId,
                email: "user@example.com",
                id: userId,
                image: null,
                name: "User",
                preferredName: null,
                timezoneId: "UTC",
                wordEditShortcut: null,
              }}
            >
              <Suspense fallback={<p>{SUSPENDED}</p>}>
                <ChatThreadDomPage
                  onSession={(next) => {
                    session = next;
                  }}
                  organizationId={organizationId}
                  threadId={threadId}
                />
              </Suspense>
            </AuthenticatedUserProvider>
          </IntlProvider>
        </QueryClientProvider>
      </ChatThreadTestRouter>
    </Profiler>,
  );
  await waitFor(() => {
    if (session === undefined || isThreadPageSuspended(view.container)) {
      panic("The page is not rendered yet");
    }
  });
  return {
    session: (): ChatThreadDomSession =>
      session ?? panic("The page is not rendered"),
    view,
  };
};
