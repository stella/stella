import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/_protected/knowledge/mcp")({
  component: () => (
    <Navigate replace search={{ kind: "mcp" }} to="/knowledge/tools" />
  ),
});
