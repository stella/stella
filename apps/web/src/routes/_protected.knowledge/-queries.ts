import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { STALE_TIME } from "@/lib/consts";
import { toAPIError } from "@/lib/errors";

// ── Key factory ─────────────────────────────────────

export const knowledgeKeys = {
  templates: {
    all: ["templates"] as const,
    list: (categoryId?: string | null) =>
      [...knowledgeKeys.templates.all, "list", { categoryId }] as const,
    detail: (templateId: string) =>
      [...knowledgeKeys.templates.all, templateId, "detail"] as const,
    preview: (templateId: string) =>
      [...knowledgeKeys.templates.all, templateId, "preview"] as const,
    versions: (templateId: string) =>
      [...knowledgeKeys.templates.all, templateId, "versions"] as const,
    clauses: (templateId: string) =>
      [...knowledgeKeys.templates.all, templateId, "clauses"] as const,
  },
  templateCategories: {
    all: ["template-categories"] as const,
  },
  clauses: {
    all: ["clauses"] as const,
    list: (params: {
      categoryId?: string | null;
      search?: string;
      limit?: number;
    }) => [...knowledgeKeys.clauses.all, "list", params] as const,
  },
  clauseCategories: {
    all: ["clause-categories"] as const,
  },
};

// ── Template queries ────────────────────────────────

export const templatesOptions = (categoryId?: string | null) =>
  queryOptions({
    queryKey: knowledgeKeys.templates.list(categoryId),
    queryFn: async ({ signal }) => {
      const query = categoryId ? { categoryId } : {};
      const response = await api.templates.get({
        query,
        fetch: { signal },
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

export const templateDetailOptions = (templateId: string) =>
  queryOptions({
    queryKey: knowledgeKeys.templates.detail(templateId),
    queryFn: async ({ signal }) => {
      const response = await api
        .templates({ templateId })
        .get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

export const templatePreviewOptions = (templateId: string) =>
  queryOptions({
    queryKey: knowledgeKeys.templates.preview(templateId),
    queryFn: async ({ signal }) => {
      const response = await api
        .templates({ templateId })
        .preview.get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

export const templateVersionsOptions = (templateId: string) =>
  queryOptions({
    queryKey: knowledgeKeys.templates.versions(templateId),
    queryFn: async ({ signal }) => {
      const response = await api
        .templates({ templateId })
        .versions.get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

export const templateClausesOptions = (templateId: string) =>
  queryOptions({
    queryKey: knowledgeKeys.templates.clauses(templateId),
    queryFn: async ({ signal }) => {
      const response = await api
        .templates({ templateId })
        .clauses.get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

// ── Category queries ────────────────────────────────

export const templateCategoriesOptions = () =>
  queryOptions({
    queryKey: knowledgeKeys.templateCategories.all,
    queryFn: async ({ signal }) => {
      const response = await api["template-categories"].get({
        fetch: { signal },
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

export const clauseCategoriesOptions = () =>
  queryOptions({
    queryKey: knowledgeKeys.clauseCategories.all,
    queryFn: async ({ signal }) => {
      const response = await api["clause-categories"].get({
        fetch: { signal },
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

// ── Clause queries ──────────────────────────────────

export const clausesOptions = (params: {
  categoryId?: string | null;
  search?: string;
  limit?: number;
}) =>
  queryOptions({
    queryKey: knowledgeKeys.clauses.list(params),
    queryFn: async ({ signal }) => {
      const query: {
        categoryId?: string;
        uncategorized?: boolean;
        q?: string;
        limit?: number;
      } = { limit: params.limit ?? 50 };

      if (params.categoryId === "uncategorized") {
        query.uncategorized = true;
      } else if (params.categoryId) {
        query.categoryId = params.categoryId;
      }

      if (params.search) {
        query.q = params.search;
      }

      const response = await api.clauses.get({
        query,
        fetch: { signal },
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });
