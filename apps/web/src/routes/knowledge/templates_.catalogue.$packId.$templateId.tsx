import type { QueryClient } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { panic } from "better-result";

import {
  catalogueTemplateOptions,
  catalogueTemplatesOptions,
} from "@/features/knowledge/public/public-knowledge-queries";
import { templateIntentSearchSchema } from "@/lib/knowledge/catalogue-intent";
import { KNOWLEDGE_CATALOGUE_PATHS } from "@/lib/knowledge/knowledge-catalogues";
import {
  isPublicKnowledgeCrawlAllowed,
  isPublicKnowledgeEnabled,
} from "@/lib/knowledge/public-knowledge-launch";
import { pageTitle } from "@/lib/page-title";
import { createPublicHead } from "@/lib/public-seo";
import { ensureRouteQueryData } from "@/lib/react-query";
import { routePresentation } from "@/routes/-route-presentation";
import { CatalogueTemplatePage } from "@/routes/knowledge/-public/catalogue-template.page";
import { CatalogueTemplatePending } from "@/routes/knowledge/-public/catalogue-template.pending";

type CatalogueTemplateLoaderArgs = {
  context: { queryClient: QueryClient };
  params: { packId: string; templateId: string };
};

export const loadCatalogueTemplate = async ({
  context,
  params,
}: CatalogueTemplateLoaderArgs) => {
  const catalogue = await ensureRouteQueryData(
    context.queryClient,
    catalogueTemplatesOptions(),
  );
  if (catalogue.length === 0) {
    notFound({ throw: true });
    return panic("TanStack Router did not throw a not-found response.");
  }
  const template = await ensureRouteQueryData(
    context.queryClient,
    catalogueTemplateOptions(params.packId, params.templateId),
  );
  // An unknown or unlisted template is not a page; an act named for it in
  // the query goes with it.
  if (template === null) {
    notFound({ throw: true });
    return panic("TanStack Router did not throw a not-found response.");
  }
  return { displayName: template.title };
};

/**
 * A catalogue template's page. The same static page for every visitor: the
 * loader reads only the published catalogue, so what the server renders and
 * what a cache may keep never depends on who asked. Who is visiting decides
 * only the actions, on the client.
 */
export const Route = createFileRoute(
  "/knowledge/templates_/catalogue/$packId/$templateId",
)({
  staticData: {
    presentation: routePresentation(
      { type: "knowledge-detail", detail: "templates" },
      {
        type: "label",
        labelKey: "knowledge.sections.templates.title",
        to: KNOWLEDGE_CATALOGUE_PATHS.templates,
      },
    ),
  },
  validateSearch: templateIntentSearchSchema,
  beforeLoad: () => {
    if (!isPublicKnowledgeEnabled()) {
      notFound({ throw: true });
    }
  },
  loader: loadCatalogueTemplate,
  head: ({ loaderData, params }) =>
    createPublicHead({
      crawlAllowed: isPublicKnowledgeCrawlAllowed(),
      path: `/knowledge/templates/catalogue/${params.packId}/${params.templateId}`,
      title:
        loaderData?.displayName !== undefined
          ? `${loaderData.displayName} · ${pageTitle("navigation.knowledge")}`
          : pageTitle("navigation.knowledge"),
      type: "article",
    }),
  component: CatalogueTemplatePage,
  pendingComponent: CatalogueTemplatePending,
});
