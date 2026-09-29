import { useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { DownloadIcon, PlusIcon, AiActionIcon } from "@stll/ui/icons";

import { ACCOUNT_GATE_OUTCOME } from "@/components/auth/require-account.logic";
import { useRequireAccount } from "@/components/auth/use-require-account";
import { publicKnowledgeSource } from "@/features/knowledge/public/public-knowledge";
import type { CatalogueTemplate } from "@/features/knowledge/public/public-knowledge";
import { KnowledgeStatusMessage } from "@/features/knowledge/views/knowledge-status-message";
import { TemplateLibraryView } from "@/features/knowledge/views/templates/template-list-view";
import { TemplateRowView } from "@/features/knowledge/views/templates/template-row-view";
import { detached } from "@/lib/detached";
import { catalogueTemplateHref } from "@/lib/knowledge/catalogue-intent";
import type { TemplateIntent } from "@/lib/knowledge/catalogue-intent";

/**
 * The published template catalogue as a list: the same list view a library
 * uses, fed from the catalogue. Every act that would write to a library goes
 * through the template's page, where it is confirmed; a visitor without an
 * account is asked for one first and brought back to that page.
 */
export const PublicTemplatesCatalogue = () => {
  const t = useTranslations();
  const navigate = useNavigate();
  const { source, byKey } = publicKnowledgeSource.useCatalogueTemplates();
  const ensureAccount = useRequireAccount();

  const openTemplate = (
    template: CatalogueTemplate,
    intent?: TemplateIntent,
  ) => {
    detached(
      navigate({
        href: catalogueTemplateHref(template.pack.id, template.id, intent),
      }),
      "knowledge-catalogue.open-template",
    );
  };

  const request = (template: CatalogueTemplate, intent: TemplateIntent) => {
    const outcome = ensureAccount({
      returnTo: catalogueTemplateHref(template.pack.id, template.id, intent),
    });
    if (outcome === ACCOUNT_GATE_OUTCOME.allowed) {
      openTemplate(template, intent);
    }
  };

  return (
    <TemplateLibraryView
      actions={{ loadMore: () => undefined }}
      emptyState={
        <KnowledgeStatusMessage>
          {t("knowledge.catalogue.unavailable")}
        </KnowledgeStatusMessage>
      }
      renderRow={(template, row) => {
        const entry = byKey.get(template.id);
        if (entry === undefined) {
          return null;
        }
        return (
          <TemplateRowView
            actions={{
              open: () => openTemplate(entry),
              use: () => request(entry, "use"),
              menu: [
                {
                  label: t("templates.useTemplate"),
                  icon: <AiActionIcon />,
                  onClick: () => request(entry, "use"),
                },
                {
                  label: t("knowledge.catalogue.addToLibrary"),
                  icon: <PlusIcon />,
                  onClick: () => request(entry, "add"),
                },
                {
                  label: t("common.download"),
                  icon: <DownloadIcon />,
                  onClick: () => request(entry, "download"),
                },
              ],
            }}
            categoryName={null}
            density={row.density}
            key={template.id}
            template={template}
          />
        );
      }}
      source={source}
    />
  );
};
