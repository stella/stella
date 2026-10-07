import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import type { KnowledgeSource } from "@/features/knowledge/views/knowledge-seam";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import {
  knowledgeKeys,
  templateCategoriesOptions,
  templateDetailOptions,
  templatesOptions,
} from "@/lib/knowledge/queries";
import { toSafeId } from "@/lib/safe-id";
import { useQueryView } from "@/lib/use-query-view";
import { useQueryViewError } from "@/lib/use-query-view-error";

type TemplatePatch = Parameters<ReturnType<typeof api.templates>["post"]>[0];

/**
 * The organization's template library, read through the tenant queries. The
 * categories keep their full shape for the member category tools.
 */
const useTemplates = (
  organizationId: string,
  selectedCategoryId: string | null,
) => {
  const {
    data: templatesData,
    isLoading,
    isError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery(templatesOptions(organizationId, selectedCategoryId));
  const categoriesDataQuery = useQuery(
    templateCategoriesOptions(organizationId),
  );
  const categoriesDataView = useQueryView(categoriesDataQuery);
  useQueryViewError(categoriesDataView);
  const categoriesData =
    categoriesDataView.type === "items" ? categoriesDataView.items : undefined;

  const templates = templatesData
    ? templatesData.pages.flatMap((page) => page.items)
    : [];
  const categories =
    categoriesData && "categories" in categoriesData
      ? categoriesData.categories
      : [];

  const status = ((): KnowledgeSource<"templates">["status"] => {
    if (isLoading) {
      return "loading";
    }
    if (isError) {
      return "error";
    }
    return "ready";
  })();

  return {
    status,
    templates,
    categories,
    selectedCategoryId,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  };
};

const useTemplateDetail = (organizationId: string, templateId: string) =>
  useQuery(templateDetailOptions(organizationId, templateId));

/** Reads of the organization's templates. */
export const memberTemplatesSource = {
  useTemplates,
  useTemplateDetail,
};

/**
 * The organization's template writes, unchanged from the calls the pages made
 * before: each returns the API response so the caller keeps its own toasts.
 */
const useTemplateActions = (organizationId: string) => {
  const queryClient = useQueryClient();

  const invalidateTemplates = () => {
    detached(
      queryClient.invalidateQueries({
        queryKey: knowledgeKeys.templates.all(organizationId),
      }),
      "knowledge-templates.invalidate-templates",
    );
  };

  const invalidateCategories = () => {
    detached(
      queryClient.invalidateQueries({
        queryKey: knowledgeKeys.templateCategories.all(organizationId),
      }),
      "knowledge-templates.invalidate-categories",
    );
  };

  return {
    invalidateTemplates,
    invalidateCategories,
    discover: async (file: File) => api.templates.discover.post({ file }),
    upload: async (file: File, name: string) =>
      api.templates.put({ file, name }),
    createBlank: async (name: string) => api.templates.blank.put({ name }),
    createFromStyleSet: async (name: string, styleSetId: string) =>
      api.templates["style-set"].put({
        name,
        styleSetId: toSafeId<"styleSet">(styleSetId),
      }),
    update: async (templateId: string, patch: TemplatePatch) =>
      api.templates({ templateId }).post(patch),
    remove: async (templateId: string) =>
      api.templates({ templateId }).delete(),
    /** Copies a catalogue template into the library, or reports the copy
     *  already there; the server binds the organization and checks the role. */
    installFromCatalogue: async (packId: string, templateSlug: string) =>
      api["template-packs"]({ packId }).install.post({
        templateSlugs: [templateSlug],
      }),
    /**
     * The audited presigned URL of the template's source DOCX, read from its
     * detail; `null` when the detail could not be read.
     */
    readSourceUrl: async (templateId: string): Promise<string | null> => {
      const { data, error } = await api
        .templates({ templateId: toSafeId<"template">(templateId) })
        .get();
      return error ? null : data.presignedUrl;
    },
  };
};

/** Writes to the organization's templates. */
export const memberTemplatesActions = {
  useTemplateActions,
};
