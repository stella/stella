import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import * as v from "valibot";

import { getTranslator } from "@/i18n/i18n-store";
import { publicToolsCataloguePath } from "@/lib/knowledge/public-tools-path";
import { pageTitle } from "@/lib/page-title";
import { createPublicToolsHead } from "@/lib/public-tools-seo";
import { TOOLS_KIND_FILTERS } from "@/lib/tools-catalogue";
import { routeSearchSchema } from "@/route-search-params";
import { PublicToolsIndexRoute } from "@/routes/tools/-index.page";
import { PublicToolsIndexPending } from "@/routes/tools/-index.pending";

// Public SEO page: a bad `?kind=` value (e.g. `?kind=skills`) must degrade
// to the default "all" filter, not throw into the router's default error
// boundary. `v.fallback` swallows the parse failure and yields "all",
// rendering the page as if the param were absent.
const searchSchema = routeSearchSchema({
  kind: v.fallback(v.optional(v.picklist(TOOLS_KIND_FILTERS), "all"), "all"),
});

// Goes once the Knowledge flag is permanent (see ./route.tsx).
export const Route = createFileRoute("/tools/")({
  validateSearch: searchSchema,
  search: {
    middlewares: [stripSearchParams({ kind: "all" })],
  },
  head: () => {
    const t = getTranslator();
    return createPublicToolsHead({
      description: t("publicTools.metaDescription"),
      path: publicToolsCataloguePath(),
      title: pageTitle("knowledge.sections.tools.title"),
      type: "website",
    });
  },
  component: PublicToolsIndexRoute,
  pendingComponent: PublicToolsIndexPending,
});
