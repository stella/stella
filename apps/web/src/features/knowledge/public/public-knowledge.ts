import { useQuery } from "@tanstack/react-query";

import {
  catalogueStartersOptions,
  catalogueTemplateOptions,
  catalogueTemplatePreviewOptions,
  catalogueTemplatesOptions,
} from "@/features/knowledge/public/public-knowledge-queries";
import type { CatalogueTemplate } from "@/features/knowledge/public/public-knowledge-queries";
import type { KnowledgeSource } from "@/features/knowledge/views/knowledge-seam";
import type { CatalogueTemplatePreview } from "@/features/knowledge/views/templates/template-catalogue-detail-view";
import type {
  KnowledgeCatalogueTemplate,
  KnowledgeTemplate,
} from "@/features/knowledge/views/templates/templates-seam";
import { detached } from "@/lib/detached";
import { useQueryView } from "@/lib/use-query-view";
import { useQueryViewError } from "@/lib/use-query-view-error";

/** A catalogue template's id in the shared views: its pack and its slug. */
const catalogueTemplateKey = (template: CatalogueTemplate): string =>
  `${template.pack.id}/${template.id}`;

/**
 * A catalogue template as a list row. What only a library knows (its use,
 * its author, its edit times) is left out rather than invented.
 */
const toKnowledgeTemplate = (
  template: CatalogueTemplate,
): KnowledgeTemplate => ({
  id: catalogueTemplateKey(template),
  name: template.title,
  fieldCount: template.fields.length,
  categoryId: null,
  tags: template.legalArea === null ? null : [template.legalArea],
  languages: [...template.languages],
  whenToUse: null,
  whenNotToUse: null,
});

const toCatalogueDetail = (
  template: CatalogueTemplate,
): KnowledgeCatalogueTemplate => ({
  title: template.title,
  packName: template.pack.name,
  license: template.license,
  licenseUrl: template.pack.licenseUrl,
  jurisdictions: template.jurisdictions.map(({ country, subdivision }) =>
    subdivision ? `${country}-${subdivision}` : country,
  ),
  languages: template.languages,
  legalArea: template.legalArea,
  fields: template.fields,
  disclaimer: template.pack.disclaimer,
});

/** Whether the published catalogue has any templates to browse. */
const useCatalogueTemplatesAvailable = () => {
  const { data, status } = useQuery({
    ...catalogueTemplatesOptions(),
    select: (templates) => templates.length > 0,
  });
  return { available: data === true, status };
};

/** The catalogue as the template list renders it, with each row's source. */
const useCatalogueTemplates = () => {
  const { data, isLoading, isError } = useQuery(catalogueTemplatesOptions());
  // Nothing is listed until the catalogue has been read.
  const catalogue: readonly CatalogueTemplate[] = data ?? [];
  const status = ((): KnowledgeSource<"templates">["status"] => {
    if (isLoading) {
      return "loading";
    }
    if (isError) {
      return "error";
    }
    return "ready";
  })();

  const source: KnowledgeSource<"templates"> = {
    status,
    templates: catalogue.map(toKnowledgeTemplate),
    categories: [],
    selectedCategoryId: null,
    hasNextPage: false,
    isFetchingNextPage: false,
  };
  const byKey = new Map(
    catalogue.map((template) => [catalogueTemplateKey(template), template]),
  );
  return { source, byKey };
};

/** One catalogue template's page: `undefined` while loading, `null` when the
 *  catalogue does not list it. */
const useCatalogueTemplate = (packId: string, templateId: string) => {
  const { data, isError } = useQuery(
    catalogueTemplateOptions(packId, templateId),
  );
  return {
    isError,
    template:
      data === undefined || data === null ? data : toCatalogueDetail(data),
  };
};

const useCatalogueTemplatePreview = (
  packId: string,
  templateId: string,
): CatalogueTemplatePreview => {
  const dataQuery = useQuery(
    catalogueTemplatePreviewOptions(packId, templateId),
  );
  const { isLoading } = dataQuery;
  const dataView = useQueryView(dataQuery);
  useQueryViewError(dataView);
  const data = dataView.type === "items" ? dataView.items : undefined;
  if (isLoading) {
    return { status: "loading" };
  }
  if (!data) {
    return { status: "unavailable" };
  }
  return {
    status: "ready",
    paragraphs: data.paragraphs,
    structureErrors: data.structureErrors,
  };
};

/** The ready-made playbooks, as the playbooks page lists them. */
/** A published ready-made playbook, as the catalogue lists it. */
type CatalogueStarter = {
  id: string;
  name: string;
  description: string;
  positionCount: number;
};

type CatalogueStartersRead = {
  data: readonly CatalogueStarter[] | undefined;
  isLoading: boolean;
  isError: boolean;
};

/**
 * The ready-made playbooks as the page shows them. A read that failed with
 * nothing to show is an error the visitor can retry, never an empty list.
 */
export const toCatalogueStarters = (
  { data, isLoading, isError }: CatalogueStartersRead,
  retry: () => void,
): KnowledgeSource<"playbooks">["starters"] => {
  if (isLoading) {
    return { status: "loading", items: [], pendingStarterId: null };
  }
  if (data === undefined) {
    return isError
      ? { status: "error", items: [], pendingStarterId: null, retry }
      : { status: "loading", items: [], pendingStarterId: null };
  }
  return {
    status: "ready",
    items: data.map((starter) => ({
      starterId: starter.id,
      name: starter.name,
      description: starter.description,
      positionCount: starter.positionCount,
    })),
    pendingStarterId: null,
  };
};

const useCatalogueStarters = (): KnowledgeSource<"playbooks">["starters"] => {
  const read = useQuery(catalogueStartersOptions());
  return toCatalogueStarters(read, () => {
    detached(read.refetch(), "public-knowledge.starters-retry");
  });
};

/**
 * Reads of the published catalogue: the same for every visitor, keyed apart
 * from any organization's Knowledge. The only source a page for visitors
 * without an account may use.
 */
export const publicKnowledgeSource = {
  useCatalogueTemplates,
  useCatalogueTemplatesAvailable,
  useCatalogueTemplate,
  useCatalogueTemplatePreview,
  useCatalogueStarters,
};

export type { CatalogueTemplate };
