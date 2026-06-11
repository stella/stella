import { useEffect, useRef } from "react";

import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { DefaultPendingComponent } from "@/components/route-components";
import { createChatThreadId } from "@/lib/chat-thread-ref";
import { pageTitle } from "@/lib/page-title";

// Deliberately NOT nested under the /chat layout (`chat_` segment):
// the layout wraps children in <RequireAIKey>, which replaces them
// with the connect-provider gate when the org has no AI access. The
// redirect must mount unconditionally so /chat/new always lands on
// /chat/$threadId, where the gate (or the thread) renders as usual.
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

  useEffect(() => {
    if (didRedirectRef.current) {
      return;
    }

    didRedirectRef.current = true;
    void navigate({
      params: { threadId: createChatThreadId() },
      replace: true,
      to: "/chat/$threadId",
    });
  }, [navigate]);

  return <DefaultPendingComponent />;
}
