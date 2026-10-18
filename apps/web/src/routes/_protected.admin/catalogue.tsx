import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/_protected/admin/catalogue")({
  component: () => <Navigate replace to="/knowledge/tools" />,
});
