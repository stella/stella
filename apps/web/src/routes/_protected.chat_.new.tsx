import { useRef } from "react";

import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { useMountEffect } from "@/hooks/use-effect";
import { createChatThreadId } from "@/lib/chat-thread-ref";
import { detached } from "@/lib/detached";
import { pageTitle } from "@/lib/page-title";
import { redirectRouteComponent } from "@/routes/-route-pending-view";
import { routePresentation } from "@/routes/-route-presentation";

// Keep the redirect outside the /chat layout (`chat_` segment): it needs no
// composer or availability feedback before opening the new thread route.
// While it runs it shows the new thread's pending view.
export const Route = createFileRoute("/_protected/chat_/new")({
  staticData: { presentation: routePresentation({ type: "inherit" }) },
  head: () => ({
    meta: [{ title: pageTitle("navigation.chat") }],
  }),
  component: redirectRouteComponent({
    navigator: NewChatNavigator,
    to: "/chat/$threadId",
  }),
});

// Redirect from a mounted component instead of throwing from
// beforeLoad: a redirect thrown while the client-side router is
// still booting can escape as an uncaught error while `_protected`
// (ssr: false, null pendingComponent) shows nothing, leaving cold
// direct loads of /chat/new on a blank page.
function NewChatNavigator() {
  const navigate = useNavigate();
  const didRedirectRef = useRef(false);

  useMountEffect(() => {
    if (didRedirectRef.current) {
      return;
    }

    didRedirectRef.current = true;
    detached(
      navigate({
        params: { threadId: createChatThreadId() },
        replace: true,
        to: "/chat/$threadId",
      }),
      "chat-new.navigate",
    );
  });

  return null;
}
