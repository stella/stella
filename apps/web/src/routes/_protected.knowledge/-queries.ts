import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { STALE_TIME } from "@/lib/consts";
import { APIError, toAPIError } from "@/lib/errors";
import type { SafeId } from "@/lib/safe-id";
import { toSafeId } from "@/lib/safe-id";

// ── Key factory ─────────────────────────────────────

const SKILLS_PAGE_SIZE = 100;
const PLAYBOOKS_PAGE_SIZE = 50;

type SkillsPageKey = {
  limit: number;
};

type PlaybooksPageKey = {
  limit: number;
};

type ClausesListKey = {
  categoryId?: string | null | undefined;
  search?: string | undefined;
  limit?: number | undefined;
};

export const knowledgeKeys = {
  skills: {
    all: (organizationId: string) => ["skills", organizationId],
    list: (organizationId: string, { limit }: SkillsPageKey) => [
      ...knowledgeKeys.skills.all(organizationId),
      "list",
      { limit },
    ],
    detail: (organizationId: string, skillId: string) => [
      ...knowledgeKeys.skills.all(organizationId),
      skillId,
      "detail",
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
    // Resolved plain text of each linked clause slot, for the Fill subtab's
    // live in-document preview. Lives in the templates subtree so editing a
    // clause link (which invalidates templates) refreshes the preview text.
    clausePreview: (organizationId: string, templateId: string) => [
      ...knowledgeKeys.templates.all(organizationId),
      templateId,
      "clause-preview",
    ],
    check: (organizationId: string, templateId: string) => [
      ...knowledgeKeys.templates.all(organizationId),
      templateId,
      "check",
    ],
    docxBuffer: (organizationId: string, templateId: string) => [
      ...knowledgeKeys.templates.all(organizationId),
      templateId,
      "docx-buffer",
    ],
  },
  templateCategories: {
    all: (organizationId: string) => ["template-categories", organizationId],
  },
  templateRecipes: {
    all: (organizationId: string) => ["template-recipes", organizationId],
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
    detail: (organizationId: string, clauseId: string) => [
      ...knowledgeKeys.clauses.all(organizationId),
      clauseId,
      "detail",
    ],
  },
  clauseCategories: {
    all: (organizationId: string) => ["clause-categories", organizationId],
  },
  playbooks: {
    all: (organizationId: string) => ["playbooks", organizationId],
    list: (organizationId: string, { limit }: PlaybooksPageKey) => [
      ...knowledgeKeys.playbooks.all(organizationId),
      "list",
      { limit },
    ],
    detail: (organizationId: string, playbookId: string) => [
      ...knowledgeKeys.playbooks.all(organizationId),
      playbookId,
      "detail",
    ],
    versions: (organizationId: string, playbookId: string) => [
      ...knowledgeKeys.playbooks.all(organizationId),
      playbookId,
      "versions",
    ],
  },
  playbookStarters: {
    all: (organizationId: string) => ["playbook-starters", organizationId],
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

// Fetches the template's source .docx bytes via the presigned download URL
// from templateDetailOptions, for a full-fidelity Folio preview. Keyed on the
// template (not the rotating presigned URL) so it caches with the template and
// is cleared by templates-subtree invalidation on update.
export const templateDocxBufferOptions = (
  organizationId: string,
  templateId: string,
  presignedUrl: string,
) =>
  // eslint-disable-next-line @tanstack/query/exhaustive-deps -- presignedUrl rotates; intentionally keyed on the stable template id so the cache survives URL refresh (see comment above).
  queryOptions({
    queryKey: knowledgeKeys.templates.docxBuffer(organizationId, templateId),
    queryFn: async ({ signal }) => {
      const response = await fetch(presignedUrl, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });

      if (!response.ok) {
        throw new APIError({
          status: response.status,
          message: "Failed to fetch template document from storage",
        });
      }

      return response.arrayBuffer();
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

const TEMPLATE_VERSIONS_PAGE_SIZE = 20;

export const templateVersionsOptions = (
  organizationId: string,
  templateId: string,
) =>
  infiniteQueryOptions({
    queryKey: knowledgeKeys.templates.versions(organizationId, templateId),
    queryFn: async ({ pageParam, signal }) => {
      const query: { limit: number; cursor?: string } = {
        limit: TEMPLATE_VERSIONS_PAGE_SIZE,
      };
      if (pageParam !== "") {
        query.cursor = pageParam;
      }
      const response = await api
        .templates({ templateId: toSafeId<"template">(templateId) })
        .versions.get({ query, fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }
      const page = response.data;
      if (!("items" in page)) {
        // 404 body shape; the error channel already covers real 404s.
        throw new APIError({ status: 404, message: "Template not found" });
      }
      return page;
    },
    initialPageParam: "",
    getNextPageParam: (lastPage) => lastPage.nextCursor,
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

// Resolved plain text for each linked clause slot (slotName -> text). The
// Fill subtab merges this into its preview values map so linked clause slots
// preview their clause body, mirroring what download/fill produces.
export const templateClausePreviewOptions = (
  organizationId: string,
  templateId: string,
) =>
  queryOptions({
    queryKey: knowledgeKeys.templates.clausePreview(organizationId, templateId),
    queryFn: async ({ signal }) => {
      const response = await api.clauses["template-slot-preview"]({
        templateId: toSafeId<"template">(templateId),
      }).get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

// Pre-flight validation findings. No staleTime: the author typically edits
// the template and re-opens the check, so each mount refetches.
export const templateCheckOptions = (
  organizationId: string,
  templateId: string,
) =>
  queryOptions({
    queryKey: knowledgeKeys.templates.check(organizationId, templateId),
    queryFn: async ({ signal }) => {
      const response = await api
        .templates({ templateId: toSafeId<"template">(templateId) })
        .check.get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });

// ── Recipe queries ──────────────────────────────────

// The full org-wide recipe set: bounded server-side, no pagination.
export const templateRecipesOptions = (organizationId: string) =>
  queryOptions({
    queryKey: knowledgeKeys.templateRecipes.all(organizationId),
    queryFn: async ({ signal }) => {
      const response = await api["template-recipes"].get({
        fetch: { signal },
      });

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

export const clauseDetailOptions = (organizationId: string, clauseId: string) =>
  queryOptions({
    queryKey: knowledgeKeys.clauses.detail(organizationId, clauseId),
    queryFn: async ({ signal }) => {
      const response = await api.clauses({ clauseId }).get({
        fetch: { signal },
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

// ── Playbook queries ────────────────────────────────

// The org playbook cap equals the API's max page size, so one request returns
// every playbook; pickers that launch a playbook (review facet, files-table run
// menu) need them all selectable rather than the first default page.
export const PLAYBOOK_PICKER_LIMIT = 100;

export const playbooksOptions = (
  organizationId: string,
  limit: number = PLAYBOOKS_PAGE_SIZE,
) =>
  queryOptions({
    queryKey: knowledgeKeys.playbooks.list(organizationId, { limit }),
    queryFn: async ({ signal }) => {
      const response = await api.playbooks.get({
        query: { limit },
        fetch: { signal },
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

// Org-owned document-type taxonomy, used to scope a playbook to a document type
// in the editor. Root-scoped API (keyed off the active org); keyed by org so a
// switch doesn't serve a stale taxonomy.
export const documentTypesOptions = (organizationId: string) =>
  queryOptions({
    queryKey: ["document-types", organizationId] as const,
    queryFn: async ({ signal }) => {
      const response = await api["document-types"].get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

// Ready-made starter playbooks (NDA, DPA, MSA) a user can instantiate into
// their org in one click. Minimal metadata only — the gallery does not need
// the full position bodies.
export const playbookStartersOptions = (organizationId: string) =>
  queryOptions({
    queryKey: knowledgeKeys.playbookStarters.all(organizationId),
    queryFn: async ({ signal }) => {
      const response = await api.playbooks.starters.get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

export const playbookDetailOptions = (
  organizationId: string,
  playbookId: string,
) =>
  queryOptions({
    queryKey: knowledgeKeys.playbooks.detail(organizationId, playbookId),
    queryFn: async ({ signal }) => {
      const response = await api
        .playbooks({ playbookId: toSafeId<"playbookDefinition">(playbookId) })
        .get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

// Approval-version history for a playbook: a small, bounded, per-parent
// collection (one row per approve call), so a plain list is enough — no
// cursor pagination, mirroring the backend's `list-versions` handler.
export const playbookVersionsOptions = (
  organizationId: string,
  playbookId: string,
) =>
  queryOptions({
    queryKey: knowledgeKeys.playbooks.versions(organizationId, playbookId),
    queryFn: async ({ signal }) => {
      const response = await api
        .playbooks({ playbookId: toSafeId<"playbookDefinition">(playbookId) })
        .versions.get({ fetch: { signal } });

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
      const query: { limit: number; cursor?: string } = {
        limit: SKILLS_PAGE_SIZE,
      };
      if (pageParam !== "") {
        query.cursor = pageParam;
      }
      const response = await api.skills.get({
        query,
        fetch: { signal },
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    initialPageParam: "",
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

export const skillDetailOptions = (organizationId: string, skillId: string) =>
  queryOptions({
    queryKey: knowledgeKeys.skills.detail(organizationId, skillId),
    queryFn: async ({ signal }) => {
      const response = await api
        .skills({ skillId: toSafeId<"agentSkill">(skillId) })
        .get({ fetch: { signal } });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
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
