import { createFileRoute, notFound } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { publicKnowledgeSource } from "@/features/knowledge/public/public-knowledge";
import { catalogueTemplateOptions } from "@/features/knowledge/public/public-knowledge-queries";
import { KnowledgeStatusMessage } from "@/features/knowledge/views/knowledge-status-message";
import { TemplateCatalogueDetailView } from "@/features/knowledge/views/templates/template-catalogue-detail-view";
import { detached } from "@/lib/detached";
import { templateIntentSearchSchema } from "@/lib/knowledge/catalogue-intent";
import { pageTitle } from "@/lib/page-title";
import { isPublicKnowledgeEnabled } from "@/lib/public-knowledge-launch";
import { ensureRouteQueryData } from "@/lib/react-query";
import { CatalogueTemplateActions } from "@/routes/knowledge/-catalogue-template-actions";

/**
 * A catalogue template's page. The same static page for every visitor: the
 * loader reads only the published catalogue, so what the server renders and
 * what a cache may keep never depends on who asked. Who is visiting decides
 * only the actions, on the client.
 */
export const Route = createFileRoute(
  "/knowledge/templates_/catalogue/$packId/$templateId",
)({
  validateSearch: templateIntentSearchSchema,
  beforeLoad: () => {
    if (!isPublicKnowledgeEnabled()) {
      throw notFound();
    }
  },
  loader: async ({ context, params }) => {
    const template = await ensureRouteQueryData(
      context.queryClient,
      catalogueTemplateOptions(params.packId, params.templateId),
    );
    // An unknown or unlisted template is not a page; an act named for it in
    // the query goes with it.
    if (template === null) {
      throw notFound();
    }
    return { displayName: template.title };
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title:
          loaderData === undefined
            ? pageTitle("navigation.knowledge")
            : `${loaderData.displayName} · ${pageTitle("navigation.knowledge")}`,
      },
    ],
  }),
  component: CatalogueTemplatePage,
});

function CatalogueTemplatePage() {
  const t = useTranslations();
  const packId = Route.useParams({ select: (params) => params.packId });
  const templateId = Route.useParams({ select: (params) => params.templateId });
  const intent = Route.useSearch({ select: (search) => search.intent });
  const navigate = Route.useNavigate();
  const { template } = publicKnowledgeSource.useCatalogueTemplate(
    packId,
    templateId,
  );
  const preview = publicKnowledgeSource.useCatalogueTemplatePreview(
    packId,
    templateId,
  );

  if (template === undefined) {
    return (
      <KnowledgeStatusMessage>{t("common.loading")}</KnowledgeStatusMessage>
    );
  }
  if (template === null) {
    return (
      <KnowledgeStatusMessage>
        {t("knowledge.catalogue.notFound")}
      </KnowledgeStatusMessage>
    );
  }

  return (
    <TemplateCatalogueDetailView
      actions={
        <CatalogueTemplateActions
          intent={intent}
          onIntentSettled={() => {
            detached(
              navigate({ replace: true, search: {} }),
              "knowledge-catalogue.clear-intent",
            );
          }}
          packId={packId}
          templateName={template.title}
          templateSlug={templateId}
        />
      }
      preview={preview}
      template={template}
    />
  );
}
