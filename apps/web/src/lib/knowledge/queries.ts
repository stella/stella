import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { panic, TaggedError } from "better-result";

import { api } from "@/lib/api";
import { DOCX_MIME, STALE_TIME } from "@/lib/consts";
import { APIError, toAPIError, unwrapEden } from "@/lib/errors/api";
import { fetchWithTimeout } from "@/lib/fetch";
import type { QueryOptionsInput } from "@/lib/react-query";
import {
  agentSkillsQueryRoot,
  mcpQueryRoot,
} from "@/lib/resource-query-roots.logic";
import type { SafeId } from "@/lib/safe-id";
import { toSafeId } from "@/lib/safe-id";

// ── Key factory ─────────────────────────────────────

const SKILLS_PAGE_SIZE = 100;
const PLAYBOOKS_PAGE_SIZE = 50;
const TEMPLATES_PAGE_SIZE = 50;

type SkillsPageKey = {
  limit: number;
};

type PlaybooksPageKey = {
  limit: number;
};

type TemplatesPageKey = {
  categoryId: string | null;
  limit: number;
};

type FlowsPageKey = {
  limit: number;
};

type ClausesListKey = {
  categoryId?: string | null | undefined;
  search?: string | undefined;
  limit?: number | undefined;
};

const FILL_DISCOVER_SEGMENT = "fill-discover";

export const knowledgeKeys = {
  skills: {
    root: agentSkillsQueryRoot(),
    all: (organizationId: string) => [
      ...knowledgeKeys.skills.root,
      organizationId,
    ],
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
    revisions: (organizationId: string, skillId: string) => [
      ...knowledgeKeys.skills.all(organizationId),
      skillId,
      "revisions",
    ],
    // `revisionId` is null while nothing is selected for comparison; the
    // option factory disables the query for that key rather than inventing a
    // placeholder id that would collide across skills.
    revision: (
      organizationId: string,
      skillId: string,
      revisionId: string | null,
    ) => [
      ...knowledgeKeys.skills.revisions(organizationId, skillId),
      revisionId,
    ],
    proposals: (organizationId: string, skillId: string) => [
      ...knowledgeKeys.skills.all(organizationId),
      skillId,
      "proposals",
    ],
    proposal: (
      organizationId: string,
      skillId: string,
      proposalId: string | null,
    ) => [
      ...knowledgeKeys.skills.proposals(organizationId, skillId),
      proposalId,
    ],
    comments: (organizationId: string, skillId: string) => [
      ...knowledgeKeys.skills.all(organizationId),
      skillId,
      "comments",
    ],
  },
  templates: {
    all: (organizationId: string) => ["templates", organizationId],
    list: (organizationId: string, { categoryId, limit }: TemplatesPageKey) => [
      ...knowledgeKeys.templates.all(organizationId),
      "list",
      { categoryId, limit },
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
    // live in-document preview. Nested under the `clauses` key so invalidating
    // the clause links (both edit sites do) prefix-matches and refreshes the
    // preview text; keeping it a sibling would leave the preview stale.
    clausePreview: (organizationId: string, templateId: string) => [
      ...knowledgeKeys.templates.clauses(organizationId, templateId),
      "preview",
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
    // Server re-discovered fill schema for the saved document. Nested under
    // `detail` (the document reference it depends on), keyed on the stable
    // template id only: the presigned URL rotates on every detail refetch and
    // must not be part of the cache identity.
    fillDiscover: (organizationId: string, templateId: string) => [
      ...knowledgeKeys.templates.detail(organizationId, templateId),
      FILL_DISCOVER_SEGMENT,
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
  // The settings editor and the playbook editor's Type picker read the same
  // taxonomy, so the editor's mutations invalidate `root` and refresh both.
  documentTypes: {
    root: ["document-types"],
    all: (organizationId: string) => [
      ...knowledgeKeys.documentTypes.root,
      organizationId,
    ],
  },
  playbooks: {
    all: (organizationId: string) => ["playbooks", organizationId],
    list: (organizationId: string, { limit }: PlaybooksPageKey) => [
      ...knowledgeKeys.playbooks.all(organizationId),
      "list",
      { limit },
    ],
    recent: (organizationId: string, { limit }: PlaybooksPageKey) => [
      ...knowledgeKeys.playbooks.all(organizationId),
      "recent",
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
  flows: {
    all: (organizationId: string) => ["flows", organizationId],
    list: (organizationId: string, { limit }: FlowsPageKey) => [
      ...knowledgeKeys.flows.all(organizationId),
      "list",
      { limit },
    ],
    detail: (organizationId: string, flowId: string) => [
      ...knowledgeKeys.flows.all(organizationId),
      flowId,
      "detail",
    ],
  },
  mcp: {
    root: mcpQueryRoot(),
    all: (organizationId: string) => [
      ...knowledgeKeys.mcp.root,
      organizationId,
    ],
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

/**
 * Whether a key is a `templates.fillDiscover` entry. The template editor
 * invalidates the templates subtree while excluding this one (it must refetch
 * only after the new detail lands), and reads the marker the factory appends
 * rather than restating it.
 */
export const isTemplateFillDiscoverKey = (
  queryKey: readonly unknown[],
): boolean => queryKey.at(-1) === FILL_DISCOVER_SEGMENT;

// ── Template queries ────────────────────────────────

export const templatesOptions = (
  organizationId: string,
  categoryId?: string | null,
) =>
  infiniteQueryOptions({
    queryKey: knowledgeKeys.templates.list(organizationId, {
      categoryId: categoryId ?? null,
      limit: TEMPLATES_PAGE_SIZE,
    }),
    queryFn: async ({ pageParam, signal }) => {
      const query: {
        categoryId?: SafeId<"templateCategory"> | "uncategorized";
        limit: number;
        cursor?: string;
      } = { limit: TEMPLATES_PAGE_SIZE };
      if (categoryId === "uncategorized") {
        query.categoryId = "uncategorized";
      } else if (categoryId) {
        query.categoryId = toSafeId<"templateCategory">(categoryId);
      }
      if (pageParam !== "") {
        query.cursor = pageParam;
      }
      const response = await api.templates.get({
        query,
        fetch: { signal },
      });

      return unwrapEden(response);
    },
    initialPageParam: "",
    getNextPageParam: (lastPage) => lastPage.nextCursor,
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

      return unwrapEden(response);
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

      return unwrapEden(response);
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
      const response = await fetchWithTimeout(presignedUrl, {
        signal,
        timeoutMs: 15_000,
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

// Re-parses a *saved* template's stored .docx server-side to recover the
// fillable field schema (the same merge the fill endpoint applies, so
// `{{#each}}` array fields and manifest metadata are both present). Shared by
// the Studio fill tab and any host that renders the fill form standalone, so
// both dedupe on one cache entry. Keyed on the stable template id (see the
// `fillDiscover` key comment): the presigned URL and file name are runtime-only
// context, never cache identity.
export class TemplateDocumentFetchError extends TaggedError(
  "TemplateDocumentFetchError",
)<{
  message: string;
  status: number;
}> {}

type TemplateFillDiscoverKey = {
  organizationId: string;
  templateId: string;
};

type TemplateFillDiscoverContext = {
  presignedUrl: string | undefined;
  fileName: string | undefined;
};

type TemplateFillDiscoverOptionsInput = QueryOptionsInput<
  TemplateFillDiscoverKey,
  TemplateFillDiscoverContext
>;

export const templateFillDiscoverOptions = ({
  key,
  context,
}: TemplateFillDiscoverOptionsInput) =>
  // eslint-disable-next-line @tanstack/query/exhaustive-deps -- presignedUrl/fileName are runtime-only context; keyed on the stable template id so a URL rotation does not evict this cache and force a re-download + re-discover.
  queryOptions({
    queryKey: knowledgeKeys.templates.fillDiscover(
      key.organizationId,
      key.templateId,
    ),
    queryFn: async ({ signal }) => {
      if (
        context.presignedUrl === undefined ||
        context.fileName === undefined
      ) {
        panic("template fill: saved template document is unavailable");
      }
      const res = await fetchWithTimeout(context.presignedUrl, {
        signal,
        timeoutMs: 15_000,
      });
      if (!res.ok) {
        throw new TemplateDocumentFetchError({
          message: `Template document fetch failed (${res.status})`,
          status: res.status,
        });
      }
      const blob = await res.blob();
      const file = new File([blob], context.fileName, { type: DOCX_MIME });
      const response = await api.templates.discover.post(
        { file },
        { fetch: { signal } },
      );
      if (response.error) {
        throw toAPIError(response.error);
      }
      if (response.data instanceof Response) {
        panic("template fill: discover returned a raw response");
      }
      return response.data;
    },
    enabled:
      context.presignedUrl !== undefined && context.fileName !== undefined,
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

      const page = unwrapEden(response);
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

      return unwrapEden(response);
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

      return unwrapEden(response);
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

      return unwrapEden(response);
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

      return unwrapEden(response);
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

      return unwrapEden(response);
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

      return unwrapEden(response);
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

      return unwrapEden(response);
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

      return unwrapEden(response);
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

// ── Playbook queries ────────────────────────────────

// The org playbook cap equals the API's max page size, so one request returns
// every playbook; pickers that launch a playbook (review facet, files-table run
// menu) need them all selectable rather than the first default page.
export const PLAYBOOK_PICKER_LIMIT = 100;
export const RECENT_PLAYBOOKS_LIMIT = 4;

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

      return unwrapEden(response);
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

export const recentPlaybooksOptions = (organizationId: string) =>
  queryOptions({
    queryKey: knowledgeKeys.playbooks.recent(organizationId, {
      limit: RECENT_PLAYBOOKS_LIMIT,
    }),
    queryFn: async ({ signal }) => {
      const response = await api.playbooks.recent.get({
        query: { limit: RECENT_PLAYBOOKS_LIMIT },
        fetch: { signal },
      });

      return unwrapEden(response);
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

// Org-owned document-type taxonomy, used to scope a playbook to a document type
// in the editor. Root-scoped API (keyed off the active org); keyed by org so a
// switch doesn't serve a stale taxonomy.
export const documentTypesOptions = (organizationId: string) =>
  queryOptions({
    queryKey: knowledgeKeys.documentTypes.all(organizationId),
    queryFn: async ({ signal }) => {
      const response = await api["document-types"].get({ fetch: { signal } });

      return unwrapEden(response);
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

      return unwrapEden(response);
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

      return unwrapEden(response);
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

      return unwrapEden(response);
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

// ── Flow (Workflows) queries ────────────────────────

// The org flow cap equals the API's max page size, so a single request can
// return every enabled flow; the workspace run launcher needs them all
// selectable rather than the first default page.
export const FLOW_PICKER_LIMIT = 100;

const FLOWS_PAGE_SIZE = 50;

export const flowsOptions = (
  organizationId: string,
  limit: number = FLOWS_PAGE_SIZE,
) =>
  queryOptions({
    queryKey: knowledgeKeys.flows.list(organizationId, { limit }),
    queryFn: async ({ signal }) => {
      const response = await api.flows.get({
        query: { limit },
        fetch: { signal },
      });

      return unwrapEden(response);
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

export const flowDetailOptions = (organizationId: string, flowId: string) =>
  queryOptions({
    queryKey: knowledgeKeys.flows.detail(organizationId, flowId),
    queryFn: async ({ signal }) => {
      const response = await api
        .flows({ flowId: toSafeId<"flowDefinition">(flowId) })
        .get({ fetch: { signal } });

      return unwrapEden(response);
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
      return unwrapEden(response);
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
      return unwrapEden(response);
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

// Revision history of a skill's instruction body, newest first and without
// bodies. Bounded server-side (one row per body change), so a plain list is
// enough.
export const skillRevisionsOptions = (
  organizationId: string,
  skillId: string,
) =>
  queryOptions({
    queryKey: knowledgeKeys.skills.revisions(organizationId, skillId),
    queryFn: async ({ signal }) => {
      const response = await api
        .skills({ skillId: toSafeId<"agentSkill">(skillId) })
        .revisions.get({ fetch: { signal } });
      return unwrapEden(response);
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

// One recorded revision in full. `revisionId` is null while the history menu
// has no selection, which disables the query instead of fetching.
export const skillRevisionOptions = (
  organizationId: string,
  skillId: string,
  revisionId: string | null,
) =>
  queryOptions({
    queryKey: knowledgeKeys.skills.revision(
      organizationId,
      skillId,
      revisionId,
    ),
    queryFn: async ({ signal }) => {
      if (revisionId === null) {
        panic("skill revision: query ran without a selected revision");
      }
      const response = await api
        .skills({ skillId: toSafeId<"agentSkill">(skillId) })
        .revisions({ revisionId: toSafeId<"agentSkillRevision">(revisionId) })
        .get({ fetch: { signal } });
      return unwrapEden(response);
    },
    enabled: revisionId !== null,
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

// Every proposal raised against the skill, newest first and without bodies.
// Unfiltered: the toolbar counts the open ones and renders the decided ones
// from the same list, so a per-status cache entry would only fan out requests.
export const skillProposalsOptions = (
  organizationId: string,
  skillId: string,
) =>
  queryOptions({
    queryKey: knowledgeKeys.skills.proposals(organizationId, skillId),
    queryFn: async ({ signal }) => {
      const response = await api
        .skills({ skillId: toSafeId<"agentSkill">(skillId) })
        .proposals.get({ query: {}, fetch: { signal } });
      return unwrapEden(response);
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

// One proposal with its body and the body of the revision it branched from.
// `proposalId` is null while no proposal is open, which disables the query.
export const skillProposalOptions = (
  organizationId: string,
  skillId: string,
  proposalId: string | null,
) =>
  queryOptions({
    queryKey: knowledgeKeys.skills.proposal(
      organizationId,
      skillId,
      proposalId,
    ),
    queryFn: async ({ signal }) => {
      if (proposalId === null) {
        panic("skill proposal: query ran without an open proposal");
      }
      const response = await api
        .skills({ skillId: toSafeId<"agentSkill">(skillId) })
        .proposals({
          proposalId: toSafeId<"agentSkillProposal">(proposalId),
        })
        .get({ fetch: { signal } });
      return unwrapEden(response);
    },
    enabled: proposalId !== null,
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

// Every comment anchored to the skill, across its revisions and proposals.
// No staleTime: the review view is opened to act on comments, so each mount
// should see the current set.
export const skillCommentsOptions = (organizationId: string, skillId: string) =>
  queryOptions({
    queryKey: knowledgeKeys.skills.comments(organizationId, skillId),
    queryFn: async ({ signal }) => {
      const response = await api
        .skills({ skillId: toSafeId<"agentSkill">(skillId) })
        .comments.get({ fetch: { signal } });
      return unwrapEden(response);
    },
  });

// ── MCP queries ─────────────────────────────────────

export const mcpConnectorsOptions = (organizationId: string) =>
  queryOptions({
    queryKey: knowledgeKeys.mcp.connectors(organizationId),
    queryFn: async ({ signal }) => {
      const response = await api.mcp.connectors.get({ fetch: { signal } });
      return unwrapEden(response);
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

export const mcpConnectionsOptions = (organizationId: string) =>
  queryOptions({
    queryKey: knowledgeKeys.mcp.connections(organizationId),
    queryFn: async ({ signal }) => {
      const response = await api.mcp.connections.get({ fetch: { signal } });
      return unwrapEden(response);
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });
