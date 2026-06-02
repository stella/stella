import { createFileRoute, redirect } from "@tanstack/react-router";

// Legacy "Prompts" surface — folded into Tools after the
// prompts/skills consolidation. A "prompt" is now a skill whose
// only capability is a slash command, edited from the same sheet
// as full skills. The redirect lands users on the Tools page
// pre-filtered to the skill kind so muscle-memory bookmarks keep
// working.
export const Route = createFileRoute("/_protected/knowledge/prompts")({
  beforeLoad: () => {
    throw redirect({
      to: "/knowledge/tools",
      search: { kind: "skill" },
      replace: true,
    });
  },
});
