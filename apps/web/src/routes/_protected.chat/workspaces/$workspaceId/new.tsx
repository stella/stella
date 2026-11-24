import { useRef } from "react";

import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { useMountEffect } from "@/hooks/use-effect";
import { createChatThreadId } from "@/lib/chat-thread-ref";
import { detached } from "@/lib/detached";
import { pageTitle } from "@/lib/page-title";
import { redirectRouteComponent } from "@/routes/-route-pending-view";

// While it runs it shows the new thread's pending view.
export const Route = createFileRoute(
  "/_protected/chat/workspaces/$workspaceId/new",
)({
  head: () => ({
    meta: [{ title: pageTitle("navigation.chat") }],
  }),
  component: redirectRouteComponent({
    navigator: NewWorkspaceChatNavigator,
    to: "/chat/workspaces/$workspaceId/$threadId",
  }),
});

// Redirect from a mounted component instead of throwing from
// beforeLoad: a redirect thrown while the client-side router is still
// booting can escape as an uncaught error while `_protected`
// (ssr: false, null pendingComponent) shows nothing, leaving cold
// loads on a blank page. Mirrors the global `_protected/chat_/new`.
function NewWorkspaceChatNavigator() {
  const workspaceId = Route.useParams({
    select: (params) => params.workspaceId,
  });
  const navigate = useNavigate();
  const didRedirectRef = useRef(false);

  useMountEffect(() => {
    if (didRedirectRef.current) {
      return;
    }

    didRedirectRef.current = true;
    detached(
      navigate({
        params: { threadId: createChatThreadId(), workspaceId },
        replace: true,
        to: "/chat/workspaces/$workspaceId/$threadId",
      }),
      "chat-workspace-new.navigate",
    );
  });

  return null;
}
