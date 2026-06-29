import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/_protected/settings/organization/")({
  component: () => <Navigate replace to="/settings/organization/members" />,
});
