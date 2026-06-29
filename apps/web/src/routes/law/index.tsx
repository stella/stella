import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/law/")({
  component: () => <Navigate replace to="/law/cases" />,
});
