import { createFileRoute, notFound } from "@tanstack/react-router";

import { classifyToolEntry } from "@/lib/knowledge/tool-entry";
import { pageTitle } from "@/lib/page-title";
import { routePresentation } from "@/routes/-route-presentation";
import { turnAwaySignedOutVisitor } from "@/routes/knowledge/-knowledge-member-route";
import { ToolSkillPage } from "@/routes/knowledge/-member/tool-skill.page";
import { ToolEntryNotFound } from "@/routes/knowledge/-tool-entry-not-found";
import { ToolSkillPending } from "@/routes/knowledge/-tools/tool-skill.pending";

/** An organization's own skill, by its id. Without an account there is
 *  nothing here, and nothing is asked for. */
export const Route = createFileRoute("/knowledge/tools_/skills/$skillId")({
  staticData: {
    presentation: routePresentation(
      { type: "knowledge-detail", detail: "skill" },
      {
        type: "label",
        labelKey: "knowledge.sections.tools.title",
        to: "/knowledge/tools",
      },
    ),
  },
  beforeLoad: async ({ context: { queryClient }, params }) => {
    if (classifyToolEntry(params.skillId) !== "skill") {
      notFound({ throw: true });
      return;
    }
    await turnAwaySignedOutVisitor({
      queryClient,
      visitor: { kind: "not-found" },
    });
  },
  head: () => ({
    meta: [{ title: pageTitle("knowledge.sections.tools.title") }],
  }),
  notFoundComponent: ToolEntryNotFound,
  component: ToolSkillPage,
  pendingComponent: ToolSkillPending,
});
