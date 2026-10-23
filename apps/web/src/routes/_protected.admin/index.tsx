import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/_protected/admin/")({
  component: () => <Navigate replace to="/admin/general" />,
});
