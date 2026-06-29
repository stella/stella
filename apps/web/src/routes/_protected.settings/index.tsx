import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/_protected/settings/")({
  component: () => <Navigate replace to="/settings/account/profile" />,
});
