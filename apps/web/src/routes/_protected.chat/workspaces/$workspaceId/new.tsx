import { useRef } from "react";

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { panic } from "better-result";

import { DefaultPendingComponent } from "@/components/route-components";
import { chatThreadOptions } from "@/features/chat/queries";
import { useMountEffect } from "@/hooks/use-effect";
import { detached } from "@/lib/detached";
import { pageTitle } from "@/lib/page-title";
import { ensureRouteQueryData } from "@/lib/react-query";

// Redirect from a mounted component instead of throwing from
// beforeLoad: a redirect thrown while the client-side router is still
// booting can escape as an uncaught error while `_protected`
// (ssr: false, null pendingComponent) shows nothing, leaving cold
// loads on a blank page. Mirrors the global `_protected/chat_/new`.
export const Route = createFileRoute(
  "/_protected/chat/workspaces/$workspaceId/new",
)({
  loader: async ({ context, params }) => {
    const threadId = context.chatLandingThreadId;
    if (threadId === undefined) {
      panic("New matter chat must preload its draft identity");
    }
    await ensureRouteQueryData(
      context.queryClient,
      chatThreadOptions({
        activeOrganizationId: context.user.activeOrganizationId,
        key: { scope: "workspace", workspaceId: params.workspaceId, threadId },
        context: { allowMissingThread: true },
      }),
    );
  },
  head: () => ({
    meta: [{ title: pageTitle("navigation.chat") }],
  }),
  component: NewWorkspaceChatRedirect,
});

function NewWorkspaceChatRedirect() {
  const workspaceId = Route.useParams({
    select: (params) => params.workspaceId,
  });
  const navigate = useNavigate();
  const threadId = Route.useRouteContext({
    select: (context) =>
      context.chatLandingThreadId ??
      panic("New matter chat has no draft identity"),
  });
  const didRedirectRef = useRef(false);

  useMountEffect(() => {
    if (didRedirectRef.current) {
      return;
    }

    didRedirectRef.current = true;
    detached(
      navigate({
        params: { threadId, workspaceId },
        replace: true,
        to: "/chat/workspaces/$workspaceId/$threadId",
      }),
      "chat-workspace-new.navigate",
    );
  });

  return <DefaultPendingComponent />;
}
