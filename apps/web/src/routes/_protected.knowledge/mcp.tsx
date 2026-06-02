import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_protected/knowledge/mcp")({
  beforeLoad: () => {
    throw redirect({
      to: "/knowledge/tools",
      search: { kind: "mcp" },
      replace: true,
    });
  },
});
