import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import * as v from "valibot";

import { getTranslator } from "@/i18n/i18n-store";
import { getAnalytics } from "@/lib/analytics/provider";
import { pageTitle } from "@/lib/page-title";
import { createPublicToolsHead } from "@/lib/public-tools-seo";
import {
  TOOLS_KIND_FILTERS,
  type ToolsKindFilter,
} from "@/lib/tools-catalogue";
import { PublicToolsIndex } from "@/routes/tools/-components/public-tools-index";

// Public SEO page: a bad `?kind=` value (e.g. `?kind=skills`) must degrade
// to the default "all" filter, not throw into the router's default error
// boundary. `v.fallback` swallows the parse failure and yields "all",
// rendering the page as if the param were absent.
const searchSchema = v.object({
  kind: v.fallback(v.optional(v.picklist(TOOLS_KIND_FILTERS), "all"), "all"),
});

export const Route = createFileRoute("/tools/")({
  validateSearch: searchSchema,
  search: {
    middlewares: [stripSearchParams({ kind: "all" })],
  },
  head: () => {
    const t = getTranslator();
    return createPublicToolsHead({
      description: t("publicTools.metaDescription"),
      path: "/tools",
      title: pageTitle("knowledge.sections.tools.title"),
      type: "website",
    });
  },
  component: PublicToolsIndexRoute,
});

function PublicToolsIndexRoute() {
  const kind = Route.useSearch({ select: (search) => search.kind });
  const navigate = Route.useNavigate();

  const onKindChange = (nextKind: ToolsKindFilter) => {
    navigate({ search: { kind: nextKind } }).catch((error: unknown) => {
      getAnalytics().captureError(error);
    });
  };

  return <PublicToolsIndex kind={kind} onKindChange={onKindChange} />;
}
