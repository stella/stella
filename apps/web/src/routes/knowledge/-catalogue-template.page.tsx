import { getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { publicKnowledgeSource } from "@/features/knowledge/public/public-knowledge";
import { KnowledgeStatusMessage } from "@/features/knowledge/views/knowledge-status-message";
import { TemplateCatalogueDetailView } from "@/features/knowledge/views/templates/template-catalogue-detail-view";
import { TemplateCatalogueDetailPending } from "@/features/knowledge/views/templates/template-catalogue-detail-view.pending";
import { detached } from "@/lib/detached";
import { CatalogueTemplateActions } from "@/routes/knowledge/-catalogue-template-actions";
import { CatalogueTemplateShell } from "@/routes/knowledge/-catalogue-template.pending";

const catalogueTemplateRouteApi = getRouteApi(
  "/knowledge/templates_/catalogue/$packId/$templateId",
);

/**
 * A catalogue template's page, the same for every visitor; who is visiting
 * decides only the actions. Until the catalogue and the template are read,
 * the page is its own pending phase.
 */
export const CatalogueTemplatePage = () => {
  const t = useTranslations();
  const { available, status } =
    publicKnowledgeSource.useCatalogueTemplatesAvailable();
  if (status === "error") {
    return (
      <KnowledgeStatusMessage>
        {t("knowledge.catalogue.unavailable")}
      </KnowledgeStatusMessage>
    );
  }
  return (
    <CatalogueTemplateShell>
      {status === "success" ? (
        available && <AvailableCatalogueTemplatePage />
      ) : (
        <TemplateCatalogueDetailPending />
      )}
    </CatalogueTemplateShell>
  );
};

const AvailableCatalogueTemplatePage = () => {
  const t = useTranslations();
  const packId = catalogueTemplateRouteApi.useParams({
    select: (params) => params.packId,
  });
  const templateId = catalogueTemplateRouteApi.useParams({
    select: (params) => params.templateId,
  });
  const intent = catalogueTemplateRouteApi.useSearch({
    select: (search) => search.intent,
  });
  const navigate = catalogueTemplateRouteApi.useNavigate();
  const { template } = publicKnowledgeSource.useCatalogueTemplate(
    packId,
    templateId,
  );
  const preview = publicKnowledgeSource.useCatalogueTemplatePreview(
    packId,
    templateId,
  );

  if (template === undefined) {
    return <TemplateCatalogueDetailPending />;
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
};
