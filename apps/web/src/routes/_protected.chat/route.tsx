import { createFileRoute, Outlet } from "@tanstack/react-router";

import { RequireAIKey } from "@/components/require-ai-key";
import { pageTitle } from "@/lib/page-title";
import { routePresentation } from "@/routes/-route-presentation";

export const Route = createFileRoute("/_protected/chat")({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "navigation.chat",
      to: "/chat",
    }),
  },
  head: () => ({
    meta: [{ title: pageTitle("navigation.chat") }],
  }),
  component: ChatLayout,
});

function ChatLayout() {
  return (
    <div className="flex h-full w-full flex-col items-center overflow-hidden">
      <RequireAIKey>
        <Outlet />
      </RequireAIKey>
    </div>
  );
}
