import type { ReactNode } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { DetailsGrid, DetailsItem } from "@stll/ui/details-grid";
import { ScrollArea } from "@stll/ui/scroll-area";

import { KnowledgeStatusMessage } from "@/features/knowledge/views/knowledge-status-message";
import { TemplatePreviewView } from "@/features/knowledge/views/templates/template-preview-view";
import type {
  ExtractedParagraph,
  StructureError,
} from "@/features/knowledge/views/templates/template-preview-view";
import type { KnowledgeCatalogueTemplate } from "@/features/knowledge/views/templates/templates-seam";
import { sanitizeHref } from "@/lib/sanitize-href";

/** The rendered preview, or where it stands. */
export type CatalogueTemplatePreview =
  | { status: "loading" }
  | { status: "unavailable" }
  | {
      status: "ready";
      paragraphs: readonly ExtractedParagraph[];
      structureErrors: readonly StructureError[];
    };

type TemplateCatalogueDetailViewProps = {
  template: KnowledgeCatalogueTemplate;
  preview: CatalogueTemplatePreview;
  /** Use, add, download: what the visitor may do with the template. */
  actions?: ReactNode;
};

/** A catalogue template's page: what it is, what it asks for, how it reads. */
export const TemplateCatalogueDetailView = ({
  template,
  preview,
  actions,
}: TemplateCatalogueDetailViewProps) => {
  const t = useTranslations();
  const licenseUrl = sanitizeHref(template.licenseUrl ?? undefined);

  return (
    <ScrollArea axis="vertical" className="flex-1">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-5 py-7 sm:px-7 sm:py-9">
        <header className="flex flex-col items-start justify-between gap-4 sm:flex-row">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight" dir="auto">
              {template.title}
            </h1>
            <p className="text-muted-foreground mt-1 text-sm" dir="auto">
              {template.packName}
            </p>
          </div>
          {actions !== undefined && actions !== null && (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {actions}
            </div>
          )}
        </header>

        <DetailsGrid>
          <DetailsItem label={t("onboarding.catalogueDetailLicense")}>
            <bdi>
              {licenseUrl ? (
                <a
                  className="underline underline-offset-2"
                  href={sanitizeHref(template.licenseUrl ?? undefined)}
                  rel="noreferrer"
                  target="_blank"
                >
                  {template.license}
                </a>
              ) : (
                template.license
              )}
            </bdi>
          </DetailsItem>
          {template.legalArea !== null && (
            <DetailsItem label={t("caseLaw.viewer.legalArea")}>
              <bdi>{template.legalArea}</bdi>
            </DetailsItem>
          )}
          {template.jurisdictions.length > 0 && (
            <DetailsItem label={t("onboarding.catalogueDetailJurisdictions")}>
              <bdi>{template.jurisdictions.join(", ")}</bdi>
            </DetailsItem>
          )}
          {template.languages.length > 0 && (
            <DetailsItem label={t("templates.languages")}>
              <bdi>{template.languages.join(", ")}</bdi>
            </DetailsItem>
          )}
        </DetailsGrid>

        {template.disclaimer !== null && (
          <p className="text-muted-foreground text-sm" dir="auto">
            {template.disclaimer}
          </p>
        )}

        {template.fields.length > 0 && (
          <section aria-labelledby="catalogue-template-fields">
            <h2
              className="mb-3 text-base font-semibold"
              id="catalogue-template-fields"
            >
              {t("templates.fields")}
            </h2>
            <ul className="flex flex-wrap gap-1.5">
              {template.fields.map((field) => (
                <li
                  className="bg-muted rounded-md px-2 py-0.5 text-xs font-medium"
                  dir="auto"
                  key={field}
                >
                  {field}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="catalogue-template-preview">
          <h2
            className="mb-3 text-base font-semibold"
            id="catalogue-template-preview"
          >
            {t("common.preview")}
          </h2>
          <div className="rounded-xl border px-4">
            <CataloguePreview preview={preview} />
          </div>
        </section>
      </div>
    </ScrollArea>
  );
};

const CataloguePreview = ({
  preview,
}: {
  preview: CatalogueTemplatePreview;
}) => {
  const t = useTranslations();

  switch (preview.status) {
    case "loading":
      return (
        <KnowledgeStatusMessage>{t("common.loading")}</KnowledgeStatusMessage>
      );
    case "unavailable":
      return (
        <KnowledgeStatusMessage>
          {t("knowledge.catalogue.noPreview")}
        </KnowledgeStatusMessage>
      );
    case "ready":
      return (
        <TemplatePreviewView
          paragraphs={preview.paragraphs}
          structureErrors={preview.structureErrors}
        />
      );
    default: {
      preview satisfies never;
      return panic(`Unhandled preview state: ${String(preview)}`);
    }
  }
};
