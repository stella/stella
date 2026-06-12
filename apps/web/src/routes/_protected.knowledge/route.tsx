import { createFileRoute, Outlet } from "@tanstack/react-router";

import { pageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/_protected/knowledge")({
  head: () => ({
    meta: [{ title: pageTitle("navigation.knowledge") }],
  }),
  component: KnowledgeLayout,
});

function KnowledgeLayout() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Outlet />
    </div>
  );
}
