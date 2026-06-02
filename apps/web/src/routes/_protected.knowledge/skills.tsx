import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_protected/knowledge/skills")({
  beforeLoad: () => {
    throw redirect({
      to: "/knowledge/tools",
      search: { kind: "skill" },
      replace: true,
    });
  },
});
