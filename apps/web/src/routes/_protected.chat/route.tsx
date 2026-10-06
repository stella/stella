import { useState } from "react";

import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import { panic } from "better-result";

import { RequireAIKey } from "@/components/require-ai-key";
import { chatThreadOptions } from "@/features/chat/queries";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import {
  createChatThreadId,
  getChatThreadKey,
  toChatThreadId,
} from "@/lib/chat-thread-ref";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { pageTitle } from "@/lib/page-title";
import { ensureRouteQueryData } from "@/lib/react-query";
import { ChatThreadPage } from "@/routes/_protected.chat/-components/chat-thread-page";

export const Route = createFileRoute("/_protected/chat")({
  beforeLoad: ({ location }) => ({
    chatLandingThreadId:
      location.pathname.replace(/\/$/u, "") === "/chat" ||
      location.pathname.endsWith("/new")
        ? createChatThreadId()
        : undefined,
  }),
  loader: async ({ context, location }) => {
    if (
      context.chatLandingThreadId === undefined ||
      location.pathname.replace(/\/$/u, "") !== "/chat"
    ) {
      return;
    }
    await ensureRouteQueryData(
      context.queryClient,
      chatThreadOptions({
        activeOrganizationId: context.user.activeOrganizationId,
        key: { scope: "global", threadId: context.chatLandingThreadId },
        context: { allowMissingThread: true },
      }),
    );
  },
  head: () => ({
    meta: [{ title: pageTitle("navigation.chat") }],
  }),
  component: ChatLayout,
});

function ChatLayout() {
  const { threadId, workspaceId } = useParams({
    strict: false,
    select: (params) => ({
      threadId: params.threadId,
      workspaceId: params.workspaceId,
    }),
  });
  const landingThreadId = Route.useRouteContext({
    select: (context) => context.chatLandingThreadId,
  });
  const [draftThreadRef, setDraftThreadRef] = useState(() => {
    if (threadId !== undefined) {
      return routeThreadRef(threadId, workspaceId);
    }
    if (landingThreadId === undefined) {
      return panic("Chat landing must preload its draft identity");
    }
    return routeThreadRef(landingThreadId, workspaceId);
  });
  useExternalSyncEffect(() => {
    if (threadId === undefined) {
      return;
    }
    const next = routeThreadRef(threadId, workspaceId);
    setDraftThreadRef((previous) =>
      getChatThreadKey(previous) === getChatThreadKey(next) ? previous : next,
    );
  }, [threadId, workspaceId]);
  const threadRef =
    threadId === undefined
      ? draftThreadRef
      : routeThreadRef(threadId, workspaceId);
  return (
    <div className="flex h-full w-full flex-col items-center overflow-hidden">
      <RequireAIKey>
        <ChatThreadPage
          threadRef={threadRef}
          workspaceId={
            threadRef.scope === "workspace" ? threadRef.workspaceId : undefined
          }
          landing={
            threadId === undefined
              ? { content: <Outlet />, onNewDraft: setDraftThreadRef }
              : undefined
          }
        />
        {threadId !== undefined && <Outlet />}
      </RequireAIKey>
    </div>
  );
}

function routeThreadRef(
  threadId: string,
  workspaceId: string | undefined,
): ChatThreadRef {
  if (workspaceId === undefined) {
    return { scope: "global", threadId: toChatThreadId(threadId) };
  }
  return {
    scope: "workspace",
    threadId: toChatThreadId(threadId),
    workspaceId,
  };
}
