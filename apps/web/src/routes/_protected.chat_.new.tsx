import { useRef } from "react";

import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { DefaultPendingComponent } from "@/components/route-components";
import { useMountEffect } from "@/hooks/use-effect";
import { createChatThreadId } from "@/lib/chat-thread-ref";
import { detached } from "@/lib/detached";
import { pageTitle } from "@/lib/page-title";

// Keep the redirect outside the /chat layout (`chat_` segment): it needs no
// composer or availability feedback before opening the new thread route.
export const Route = createFileRoute("/_protected/chat_/new")({
  head: () => ({
    meta: [{ title: pageTitle("navigation.chat") }],
  }),
  component: NewChatRedirect,
});

// Redirect from a mounted component instead of throwing from
// beforeLoad: a redirect thrown while the client-side router is
// still booting can escape as an uncaught error while `_protected`
// (ssr: false, null pendingComponent) shows nothing, leaving cold
// direct loads of /chat/new on a blank page.
function NewChatRedirect() {
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

  return <DefaultPendingComponent />;
}
