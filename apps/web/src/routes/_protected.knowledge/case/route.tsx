import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_protected/knowledge/case")({
  component: CaseLawLayout,
});

function CaseLawLayout() {
  return <Outlet />;
}
