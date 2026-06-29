import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/_protected/knowledge/skills")({
  component: () => (
    <Navigate replace search={{ kind: "skill" }} to="/knowledge/tools" />
  ),
});
