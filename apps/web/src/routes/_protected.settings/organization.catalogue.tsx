import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute(
  "/_protected/settings/organization/catalogue",
)({
  component: () => <Navigate replace to="/knowledge/tools" />,
});
