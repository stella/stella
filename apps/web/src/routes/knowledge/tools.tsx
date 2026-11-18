import { createFileRoute } from "@tanstack/react-router";
import * as v from "valibot";

import { KNOWLEDGE_CATALOGUE_PATHS } from "@/lib/knowledge/knowledge-catalogues";
import { pageTitle } from "@/lib/page-title";
import { routeSearchSchema } from "@/route-search-params";
import { routePresentation } from "@/routes/-route-presentation";
import "@/routes/knowledge/-components/catalogue/tool-detail-inspector-registration";
import { turnAwaySignedOutVisitor } from "@/routes/knowledge/-knowledge-member-route";
import { ToolsPage } from "@/routes/knowledge/-member/tools.page";
import { ToolsPending } from "@/routes/knowledge/-member/tools.pending";

const KIND_VALUES = ["all", "skill", "mcp"] as const;

const searchSchema = routeSearchSchema({
  kind: v.optional(v.picklist(KIND_VALUES)),
  /** Catalogue slug to open on load, e.g. `?slug=krs` from an API refusal that
   *  names where the tool is enabled. */
  slug: v.optional(v.string()),
});

// The organization's tools: what it has installed, connected and
// recommended. The published list every visitor reads (and crawlers index)
// lives at `/knowledge/tools/catalogue`.
export const Route = createFileRoute("/knowledge/tools")({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "knowledge.sections.tools.title",
      to: "/knowledge/tools",
    }),
  },
  validateSearch: searchSchema,
  beforeLoad: async ({ context: { queryClient } }) => {
    await turnAwaySignedOutVisitor({
      queryClient,
      visitor: { kind: "catalogue", to: KNOWLEDGE_CATALOGUE_PATHS.tools },
    });
  },
  head: () => ({
    meta: [{ title: pageTitle("knowledge.sections.tools.title") }],
  }),
  component: ToolsPage,
  pendingComponent: ToolsPending,
});
