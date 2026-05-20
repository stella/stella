import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { STALE_TIME } from "@/lib/consts";
import { toAPIError } from "@/lib/errors";
import type { SafeId } from "@/lib/safe-id";
import { toSafeId } from "@/lib/safe-id";

// ── Key factory ─────────────────────────────────────

const SKILLS_PAGE_SIZE = 100;

type SkillsPageKey = {
  limit: number;
};

type ClausesListKey = {
  categoryId?: string | null | undefined;
  search?: string | undefined;
  limit?: number | undefined;
};

export const knowledgeKeys = {
  shortcuts: {
    all: (organizationId: string) => ["shortcuts", organizationId],
    list: (organizationId: string) => [
      ...knowledgeKeys.shortcuts.all(organizationId),
      "list",
    ],
  },
  skills: {
    all: (organizationId: string) => ["skills", organizationId],
    list: (organizationId: string, { limit }: SkillsPageKey) => [
      ...knowledgeKeys.skills.all(organizationId),
      "list",
      { limit },
    ],
  },
  templates: {
    all: (organizationId: string) => ["templates", organizationId],
    list: (organizationId: string, categoryId?: string | null) => [
      ...knowledgeKeys.templates.all(organizationId),
      "list",
      { categoryId: categoryId ?? null },
    ],
    detail: (organizationId: string, templateId: string) => [
      ...knowledgeKeys.templates.all(organizationId),
      templateId,
      "detail",
    ],
    preview: (organizationId: string, templateId: string) => [
      ...knowledgeKeys.templates.all(organizationId),
      templateId,
      "preview",
    ],
    versions: (organizationId: string, templateId: string) => [
      ...knowledgeKeys.templates.all(organizationId),
      templateId,
      "versions",
    ],
    clauses: (organizationId: string, templateId: string) => [
      ...knowledgeKeys.templates.all(organizationId),
      templateId,
      "clauses",
    ],
  },
  templateCategories: {
    all: (organizationId: string) => ["template-categories", organizationId],
  },
  clauses: {
    all: (organizationId: string) => ["clauses", organizationId],
    list: (
      organizationId: string,
      { categoryId, search, limit }: ClausesListKey,
    ) => [
      ...knowledgeKeys.clauses.all(organizationId),
      "list",
      { categoryId: categoryId ?? null, search, limit },
    ],
  },
  clauseCategories: {
    all: (organizationId: string) => ["clause-categories", organizationId],
  },
  mcp: {
    all: (organizationId: string) => ["mcp", organizationId],
    connectors: (organizationId: string) => [
      ...knowledgeKeys.mcp.all(organizationId),
      "connectors",
    ],
    connections: (organizationId: string) => [
      ...knowledgeKeys.mcp.all(organizationId),
      "connections",
    ],
  },
};

// ── Template queries ────────────────────────────────

export const templatesOptions = (
  organizationId: string,
  categoryId?: string | null,
) =>
  queryOptions({
    queryKey: knowledgeKeys.templates.list(organizationId, categoryId),
    queryFn: async ({ signal }) => {
      const query: {
        categoryId?: SafeId<"templateCategory"> | "uncategorized";
      } = {};
      if (categoryId === "uncategorized") {
        query.categoryId = "uncategorized";
      } else if (categoryId) {
        query.categoryId = toSafeId<"templateCategory">(categoryId);
      }
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

export const templateDetailOptions = (
  organizationId: string,
  templateId: string,
) =>
  queryOptions({
    queryKey: knowledgeKeys.templates.detail(organizationId, templateId),
    queryFn: async ({ signal }) => {
      const response = await api
        .templates({ templateId: toSafeId<"template">(templateId) })
        .get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

export const templatePreviewOptions = (
  organizationId: string,
  templateId: string,
) =>
  queryOptions({
    queryKey: knowledgeKeys.templates.preview(organizationId, templateId),
    queryFn: async ({ signal }) => {
      const response = await api
        .templates({ templateId: toSafeId<"template">(templateId) })
        .preview.get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

export const templateVersionsOptions = (
  organizationId: string,
  templateId: string,
) =>
  queryOptions({
    queryKey: knowledgeKeys.templates.versions(organizationId, templateId),
    queryFn: async ({ signal }) => {
      const response = await api
        .templates({ templateId: toSafeId<"template">(templateId) })
        .versions.get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

export const templateClausesOptions = (
  organizationId: string,
  templateId: string,
) =>
  queryOptions({
    queryKey: knowledgeKeys.templates.clauses(organizationId, templateId),
    queryFn: async ({ signal }) => {
      const response = await api
        .templates({ templateId: toSafeId<"template">(templateId) })
        .clauses.get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

// ── Category queries ────────────────────────────────

export const templateCategoriesOptions = (organizationId: string) =>
  queryOptions({
    queryKey: knowledgeKeys.templateCategories.all(organizationId),
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

export const clauseCategoriesOptions = (organizationId: string) =>
  queryOptions({
    queryKey: knowledgeKeys.clauseCategories.all(organizationId),
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

export const clausesOptions = (
  organizationId: string,
  params: ClausesListKey,
) =>
  queryOptions({
    queryKey: knowledgeKeys.clauses.list(organizationId, params),
    queryFn: async ({ signal }) => {
      const query: {
        categoryId?: SafeId<"clauseCategory">;
        uncategorized?: boolean;
        q?: string;
        limit?: number;
      } = { limit: params.limit ?? 50 };

      if (params.categoryId === "uncategorized") {
        query.uncategorized = true;
      } else if (params.categoryId) {
        query.categoryId = toSafeId<"clauseCategory">(params.categoryId);
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

// ── Shortcuts queries ────────────────────────────────

export const shortcutsOptions = (organizationId: string) =>
  queryOptions({
    queryKey: knowledgeKeys.shortcuts.list(organizationId),
    queryFn: async ({ signal }) => {
      const response = await api.shortcuts.get({ fetch: { signal } });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

// ── Skills queries ───────────────────────────────────

export const skillsOptions = (organizationId: string) =>
  infiniteQueryOptions({
    queryKey: knowledgeKeys.skills.list(organizationId, {
      limit: SKILLS_PAGE_SIZE,
    }),
    queryFn: async ({ pageParam, signal }) => {
      const response = await api.skills.get({
        query: {
          limit: SKILLS_PAGE_SIZE,
          offset: pageParam,
        },
        fetch: { signal },
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

// ── MCP queries ─────────────────────────────────────

export const mcpConnectorsOptions = (organizationId: string) =>
  queryOptions({
    queryKey: knowledgeKeys.mcp.connectors(organizationId),
    queryFn: async ({ signal }) => {
      const response = await api.mcp.connectors.get({ fetch: { signal } });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

export const mcpConnectionsOptions = (organizationId: string) =>
  queryOptions({
    queryKey: knowledgeKeys.mcp.connections(organizationId),
    queryFn: async ({ signal }) => {
      const response = await api.mcp.connections.get({ fetch: { signal } });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });
