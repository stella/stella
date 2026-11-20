import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stll/ui/button";

import { publicToolPath } from "@/lib/knowledge/public-tools-path";
import { pageTitleLiteral } from "@/lib/page-title";
import {
  createPublicToolsCanonicalUrl,
  createPublicToolsHead,
  createToolEntryJsonLd,
} from "@/lib/public-tools-seo";
import { routeSearchSchema } from "@/route-search-params";
import { PublicToolDetail } from "@/routes/tools/-detail.page";
import { PublicToolDetailPending } from "@/routes/tools/-detail.pending";

// Public SEO page: a bad `?install=` value (e.g. `?install=true`) must
// degrade to "no install intent", not throw into the router's default
// error boundary. `v.fallback` swallows the parse failure and yields
// `undefined`, rendering the page as if the param were absent.
const searchSchema = routeSearchSchema({
  install: v.fallback(v.optional(v.literal("1")), undefined),
});

// Goes once the Knowledge flag is permanent (see ./route.tsx).
export const Route = createFileRoute("/tools/$slug")({
  validateSearch: searchSchema,
  loader: async ({ params }) => {
    const { loadPublicToolDetail } = await import("@/lib/public-tools-data");
    const detail = await loadPublicToolDetail(params.slug);
    if (!detail) {
      throw notFound();
    }
    return detail;
  },
  head: ({ loaderData }) => {
    if (!loaderData) {
      return {};
    }
    const { entry } = loaderData;
    const path = publicToolPath(entry.slug);
    return createPublicToolsHead({
      description: entry.description,
      jsonLd: createToolEntryJsonLd({
        author: entry.author,
        authorUrl: entry.authorUrl,
        canonicalUrl: createPublicToolsCanonicalUrl(path),
        cost: entry.cost,
        description: entry.description,
        homepage: entry.homepage,
        kind: entry.kind,
        license: entry.license,
        name: entry.displayName,
      }),
      path,
      title: pageTitleLiteral(entry.displayName),
      type: "article",
    });
  },
  notFoundComponent: PublicToolNotFound,
  component: PublicToolDetail,
  pendingComponent: PublicToolDetailPending,
});

function PublicToolNotFound() {
  const t = useTranslations();

  return (
    <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-muted-foreground text-sm">
        {t("publicTools.notFound")}
      </p>
      <Button render={<Link from="/tools/$slug" to="/tools" />}>
        {t("common.back")}
      </Button>
    </main>
  );
}
