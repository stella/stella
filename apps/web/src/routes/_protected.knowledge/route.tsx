import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_protected/knowledge")({
  component: KnowledgeLayout,
});

function KnowledgeLayout() {
  return (
    <div className="flex min-h-0 flex-1 flex-col border-t">
      <Outlet />
    </div>
  );
}
