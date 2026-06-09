import { generateText, Output } from "ai";
import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";
import * as v from "valibot";

import type { SafeDb, ScopedDb } from "@/api/db";
import {
  caseLawSearchDocuments,
  chatMessages,
  chatThreads,
  contactSearchDocuments,
  ENTITY_KINDS,
  searchDocuments,
  workspaceSearchDocuments,
} from "@/api/db/schema";
import { resolveSelectedWorkspaceIds } from "@/api/handlers/search/search";
import { aiErrorStatusBody } from "@/api/lib/ai-error";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import { getModelForRole, requireAIAvailable } from "@/api/lib/ai-models";
import { strictOutputSchema } from "@/api/lib/ai-output-schema";
import { captureError } from "@/api/lib/analytics";
import { createAIAnalyticsCallbacks } from "@/api/lib/analytics/ai";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId, tUserId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import {
  brandPersistedCaseLawDecisionId,
  brandPersistedContactId,
  brandPersistedEntityId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import { upsertChatThreadSearchDocument } from "@/api/lib/search/index-chat";
import { searchGlobal } from "@/api/lib/search/index-global";
import {
  buildSearchTsQuery,
  validateStellaSearchQuery,
} from "@/api/lib/search/query";
import {
  GLOBAL_SEARCH_RESULT_TYPES,
  type GlobalSearchHit,
  type GlobalSearchResultType,
} from "@/api/lib/search/types";

const SEARCH_SUMMARY_RESULT_LIMIT = 5;
const SEARCH_CONTEXT_CHARS_PER_RESULT = 3000;
const SEARCH_CONTEXT_TOTAL_CHARS = 14_000;
const SEARCH_REFINE_MAX_ATTEMPTS = 3;
const SEARCH_SUMMARY_CITATION_LIMIT = 5;
const CITABLE_SEARCH_RESULT_TYPES = [
  "matter",
  "contact",
  "case-law",
  ...ENTITY_KINDS,
] as const satisfies readonly GlobalSearchResultType[];

export const refineSearchOutputSchema = v.strictObject({
  query: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(LIMITS.searchQueryMaxLength),
  ),
});

export const searchSummaryOutputSchema = v.strictObject({
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  summary: v.pipe(v.string(), v.minLength(1), v.maxLength(4000)),
  citations: v.pipe(
    v.array(
      v.strictObject({
        number: v.pipe(v.number(), v.integer(), v.minValue(1)),
        reason: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
      }),
    ),
    v.maxLength(SEARCH_SUMMARY_CITATION_LIMIT),
  ),
});

export const refineSearchBodySchema = t.Object({
  query: t.String({
    minLength: 1,
    maxLength: LIMITS.searchQueryMaxLength,
  }),
  locale: t.Optional(t.String({ maxLength: 16 })),
});

const isoDateTime = t.String({ format: "date-time" });

export const summarizeSearchBodySchema = t.Object({
  query: t.String({
    minLength: 1,
    maxLength: LIMITS.searchQueryMaxLength,
  }),
  originalQuery: t.Optional(
    t.String({
      minLength: 1,
      maxLength: LIMITS.searchQueryMaxLength,
    }),
  ),
  locale: t.Optional(t.String({ maxLength: 16 })),
  workspaceIds: t.Array(tSafeId("workspace"), { maxItems: 64 }),
  types: t.Array(t.UnionEnum(GLOBAL_SEARCH_RESULT_TYPES), {
    maxItems: GLOBAL_SEARCH_RESULT_TYPES.length,
  }),
  editedByUserIds: t.Array(tUserId, { maxItems: 64 }),
  mimeTypes: t.Array(t.String({ minLength: 1, maxLength: 128 })),
  updatedFrom: t.Optional(isoDateTime),
  updatedTo: t.Optional(isoDateTime),
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: SEARCH_SUMMARY_RESULT_LIMIT,
      default: SEARCH_SUMMARY_RESULT_LIMIT,
    }),
  ),
});

export const searchSummaryChatBodySchema = t.Object({
  query: summarizeSearchBodySchema.properties.query,
  originalQuery: summarizeSearchBodySchema.properties.originalQuery,
  title: t.String({ minLength: 1, maxLength: 120 }),
  summary: t.String({ minLength: 1, maxLength: 4000 }),
  citations: t.Array(
    t.Object({
      number: t.Integer({ minimum: 1, maximum: SEARCH_SUMMARY_RESULT_LIMIT }),
    }),
    { maxItems: SEARCH_SUMMARY_CITATION_LIMIT },
  ),
  workspaceIds: summarizeSearchBodySchema.properties.workspaceIds,
  types: summarizeSearchBodySchema.properties.types,
  editedByUserIds: summarizeSearchBodySchema.properties.editedByUserIds,
  mimeTypes: summarizeSearchBodySchema.properties.mimeTypes,
  updatedFrom: summarizeSearchBodySchema.properties.updatedFrom,
  updatedTo: summarizeSearchBodySchema.properties.updatedTo,
  limit: summarizeSearchBodySchema.properties.limit,
});

type RefineSearchBody = Static<typeof refineSearchBodySchema>;
type SummarizeSearchBody = Static<typeof summarizeSearchBodySchema>;
type SearchSummaryChatBody = Static<typeof searchSummaryChatBodySchema>;

type SearchAIContext = {
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  promptCachingEnabled: boolean;
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  userId: SafeId<"user">;
};

type SearchSummaryContext = SearchAIContext & {
  accessibleWorkspaceIds: SafeId<"workspace">[];
};

// Chat threads are searchable but are not citable summary sources:
// a conversation is not a document to excerpt. They are dropped from
// the AI summary context, so everything downstream sees only the
// citable hit variants.
type CitableSearchHit = Exclude<GlobalSearchHit, { type: "chat" }>;

type SearchResultContext = {
  id: string;
  number: number;
  title: string;
  type: string;
  headline: string | null;
  content: string;
  hit: CitableSearchHit;
};

type SearchSummaryCitation = {
  href: string | null;
  id: string;
  number: number;
  title: string;
  type: string;
  reason: string;
};

const citableSummaryTypes = (
  types: readonly GlobalSearchResultType[],
): readonly GlobalSearchResultType[] => {
  if (types.length === 0) {
    return CITABLE_SEARCH_RESULT_TYPES;
  }

  return types.filter((type) => type !== "chat");
};

type SearchSummaryChatContext = {
  accessibleWorkspaceIds: SafeId<"workspace">[];
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
};

const SEARCH_REFINE_SYSTEM = `You rewrite a legal workspace search request into stella's boolean search syntax.

Supported syntax:
- AND, OR, NOT must be uppercase.
- Parentheses group clauses.
- Double quotes force exact phrases.
- A leading minus is shorthand for NOT.
- A trailing * searches a shorter word root, useful for inflection. Example: lhůt* matches lhůta, lhůtou, lhůty.
- The search engine already performs prefix matching and diacritic normalization.

Rules:
- Return a concise query, not SQL.
- Preserve the user's intent and do not invent factual constraints.
- Keep the user's language. Do not add English translations unless the user used English or explicitly asks for multilingual results.
- Add useful variants only when they are likely legal/search terms, synonyms, abbreviations, file names, party aliases, or morphology roots in the same language.
- Conversational requests are allowed. For example, "chci najít nejpřísnější smluvní pokuty" can become: smluv* AND pokut* AND (nejpřísnější OR nejvyšší OR nepřiměřen*).
- Prefer boolean recall over long exact phrases for inflected languages. For example, "lhůta pro odvolání" can become: (lhůt* AND odvol*) OR "odvolací lhůta".
- Prefer OR groups for true same-language variants, for example: předběž* AND opatřen* OR "interimní opatření".
- For file searches, consider file-name and title variants, for example: ("share purchase agreement" OR SPA OR "term sheet").
- Do not add diacritic-only variants; unaccent normalization already handles them.
- Keep the output under 500 characters.`;

const SEARCH_SUMMARY_SYSTEM = `You summarize legal search results for a lawyer.

Use only the provided result titles, snippets, and content extracts. Do not invent facts.
If the evidence is thin, say so.
Write in the requested locale.
Return a practical summary with enough detail to be useful: normally 2-4 short paragraphs.
Use inline bracket citations in the summary, for example [1] or [1][3].
Return citations as result numbers from the provided results only, with a short reason for each citation.
Prefer citing the decisions/documents that directly support the answer.`;

const compactContent = (value: unknown): string => {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+/gu, " ").trim();
};

const truncate = (text: string, maxLength: number): string =>
  text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;

type GenerateRefinedSearchQueryOptions = {
  attempt: number;
  body: RefineSearchBody;
  lastValidationError: string | null;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  promptCachingEnabled: boolean;
  stepCallbacks: ReturnType<typeof createAIAnalyticsCallbacks>["stepCallbacks"];
};

const validateSearchQueryWithPostgres = async ({
  query,
  scopedDb,
}: {
  query: string;
  scopedDb: ScopedDb;
}) =>
  await Result.tryPromise({
    try: async () => {
      await scopedDb((tx) =>
        tx.execute(sql`SELECT ${buildSearchTsQuery(query)}::text AS query`),
      );
    },
    catch: (error: unknown) => error,
  });

const generateRefinedSearchQuery = async ({
  attempt,
  body,
  lastValidationError,
  organizationId,
  orgAIConfig,
  promptCachingEnabled,
  stepCallbacks,
}: GenerateRefinedSearchQueryOptions) =>
  await Result.tryPromise({
    try: async () =>
      await generateText({
        model: getModelForRole("fast", orgAIConfig, {
          promptCachingEnabled,
          scopeKey: null,
          organizationId,
          serviceTier: "standard",
        }),
        system: SEARCH_REFINE_SYSTEM,
        prompt: JSON.stringify({
          attempt,
          locale: body.locale ?? null,
          query: body.query,
          previousValidationError: lastValidationError,
        }),
        output: Output.object({
          schema: strictOutputSchema(refineSearchOutputSchema),
        }),
        maxOutputTokens: 180,
        abortSignal: AbortSignal.timeout(20_000),
        ...stepCallbacks,
      }),
    catch: (error: unknown) => error,
  });

export const refineSearchQuery = async ({
  body,
  organizationId,
  orgAIConfig,
  promptCachingEnabled,
  safeDb,
  scopedDb,
  userId,
}: SearchAIContext & {
  body: RefineSearchBody;
}) => {
  const gate = requireAIAvailable(orgAIConfig);
  if (gate.isErr()) {
    return status(403, { message: gate.error.message });
  }

  const aiAnalytics = createAIAnalyticsCallbacks({
    usageMetering: {
      actionType: "chat",
      organizationId,
      safeDb,
      serviceTier: "standard",
      userId,
      workspaceId: null,
    },
    feature: "search.refine",
    modelRole: "fast",
    orgAIConfig,
    properties: { organization_id: organizationId },
    traceId: Bun.randomUUIDv7(),
  });

  let lastValidationError: string | null = null;

  for (let attempt = 1; attempt <= SEARCH_REFINE_MAX_ATTEMPTS; attempt++) {
    const result = await generateRefinedSearchQuery({
      attempt,
      body,
      lastValidationError,
      organizationId,
      orgAIConfig,
      promptCachingEnabled,
      stepCallbacks: aiAnalytics.stepCallbacks,
    });

    if (result.isErr()) {
      aiAnalytics.captureError(result.error);
      const mapped = aiErrorStatusBody(result.error, {
        status: 502,
        message: "Failed to improve search query",
      });
      return status(mapped.status, mapped.body);
    }

    const parsedOutput = v.safeParse(
      refineSearchOutputSchema,
      result.value.output,
    );
    if (!parsedOutput.success) {
      lastValidationError = "AI output did not match the expected schema.";
      continue;
    }

    const refinedQuery = parsedOutput.output.query.trim();
    if (!refinedQuery) {
      lastValidationError = "AI returned an empty query.";
      continue;
    }

    const validation = validateStellaSearchQuery(refinedQuery);
    if (!validation.valid) {
      lastValidationError = validation.reason;
      continue;
    }

    const postgresValidation = await validateSearchQueryWithPostgres({
      query: refinedQuery,
      scopedDb,
    });

    if (postgresValidation.isOk()) {
      return { query: refinedQuery };
    }

    lastValidationError =
      "PostgreSQL rejected the generated tsquery. Use valid stella syntax with balanced operators and searchable terms.";
  }

  return status(502, { message: "Failed to improve search query" });
};

export const summarizeSearchResults = async ({
  body,
  organizationId,
  userId,
  accessibleWorkspaceIds,
  orgAIConfig,
  promptCachingEnabled,
  safeDb,
  scopedDb,
}: SearchSummaryContext & {
  body: SummarizeSearchBody;
}) => {
  const gate = requireAIAvailable(orgAIConfig);
  if (gate.isErr()) {
    return status(403, { message: gate.error.message });
  }

  const resolved = await resolveSelectedWorkspaceIds({
    scopedDb,
    organizationId,
    accessibleWorkspaceIds,
    requestedWorkspaceIds: body.workspaceIds,
  });
  if (resolved.kind === "error") {
    return resolved.response;
  }

  const contextsResult = await loadSummaryContexts({
    accessibleWorkspaceIds,
    filters: body,
    organizationId,
    userId,
    selectedWorkspaceIds: resolved.ids,
    scopedDb,
  });

  if (!Array.isArray(contextsResult)) {
    return contextsResult;
  }

  if (contextsResult.length === 0) {
    return status(404, { message: "No results to summarize" });
  }

  const aiAnalytics = createAIAnalyticsCallbacks({
    usageMetering: {
      actionType: "chat",
      organizationId,
      safeDb,
      serviceTier: "standard",
      userId,
      workspaceId: null,
    },
    feature: "search.summary",
    modelRole: "fast",
    orgAIConfig,
    properties: {
      organization_id: organizationId,
      result_count: String(contextsResult.length),
    },
    traceId: Bun.randomUUIDv7(),
  });

  const result = await Result.tryPromise({
    try: async () =>
      await generateText({
        model: getModelForRole("fast", orgAIConfig, {
          promptCachingEnabled,
          scopeKey: null,
          organizationId,
          serviceTier: "standard",
        }),
        system: SEARCH_SUMMARY_SYSTEM,
        prompt: JSON.stringify({
          locale: body.locale ?? "en",
          originalQuery: body.originalQuery ?? body.query,
          searchQuery: body.query,
          results: contextsResult.map(toModelSearchResultContext),
        }),
        output: Output.object({
          schema: strictOutputSchema(searchSummaryOutputSchema),
        }),
        maxOutputTokens: 700,
        abortSignal: AbortSignal.timeout(30_000),
        ...aiAnalytics.stepCallbacks,
      }),
    catch: (error: unknown) => error,
  });

  if (result.isErr()) {
    aiAnalytics.captureError(result.error);
    captureError(result.error, {
      feature: "search.summary",
      organizationId,
    });
    const mapped = aiErrorStatusBody(result.error, {
      status: 502,
      message: "Failed to summarize search results",
    });
    return status(mapped.status, mapped.body);
  }

  const parsedOutput = v.safeParse(
    searchSummaryOutputSchema,
    result.value.output,
  );
  if (!parsedOutput.success) {
    return status(502, { message: "Failed to summarize search results" });
  }

  const title = parsedOutput.output.title.trim();
  const summary = parsedOutput.output.summary.trim();
  if (!title || !summary) {
    return status(502, { message: "Failed to summarize search results" });
  }

  return {
    title,
    summary,
    citations: resolveSummaryCitations({
      contexts: contextsResult,
      citations: parsedOutput.output.citations,
    }),
  };
};

const resolveSummaryCitations = ({
  contexts,
  citations,
}: {
  contexts: readonly SearchResultContext[];
  citations: readonly { number: number; reason: string }[];
}): SearchSummaryCitation[] => {
  const contextByNumber = new Map(
    contexts.map((context) => [context.number, context]),
  );
  const resolved: SearchSummaryCitation[] = [];
  const seen = new Set<number>();

  for (const citation of citations) {
    const context = contextByNumber.get(citation.number);
    const reason = citation.reason.trim();
    if (!context || !reason || seen.has(context.number)) {
      continue;
    }
    seen.add(context.number);
    resolved.push({
      href: citationHref(context),
      id: context.id,
      number: context.number,
      title: context.title,
      type: context.type,
      reason,
    });
  }

  if (resolved.length > 0) {
    return resolved;
  }

  return contexts.slice(0, 3).map((context) => ({
    href: citationHref(context),
    id: context.id,
    number: context.number,
    title: context.title,
    type: context.type,
    reason: context.headline
      ? compactContent(context.headline)
      : "Relevant search result.",
  }));
};

export const createSearchSummaryChatThread = async ({
  accessibleWorkspaceIds,
  body,
  organizationId,
  safeDb,
  scopedDb,
  search = searchGlobal,
  userId,
  recordAuditEvent,
}: SearchSummaryChatContext & {
  body: SearchSummaryChatBody;
  search?: typeof searchGlobal;
}) => {
  const resolved = await resolveSelectedWorkspaceIds({
    scopedDb,
    organizationId,
    accessibleWorkspaceIds,
    requestedWorkspaceIds: body.workspaceIds,
  });
  if (resolved.kind === "error") {
    return resolved.response;
  }

  const contextsResult = await loadSummaryContexts({
    accessibleWorkspaceIds,
    filters: body,
    organizationId,
    userId,
    selectedWorkspaceIds: resolved.ids,
    scopedDb,
    search,
  });

  if (!Array.isArray(contextsResult)) {
    return contextsResult;
  }

  const citations = resolveSummaryCitations({
    contexts: contextsResult,
    citations: body.citations.map((citation) => ({
      number: citation.number,
      reason: "Cited in the search summary.",
    })),
  });
  const citedNumberSet = new Set(citations.map((citation) => citation.number));
  const citedContexts = contextsResult.filter((context) =>
    citedNumberSet.has(context.number),
  );
  const threadId = createSafeId<"chatThread">();
  const userMessageId = createSafeId<"chatMessage">();
  const assistantMessageId = createSafeId<"chatMessage">();
  const now = new Date();
  const userText = [
    body.originalQuery ?? body.query,
    body.originalQuery ? `\nStella query: ${body.query}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const assistantText = buildChatSummaryText({
    title: body.title,
    summary: body.summary,
    citations,
    contexts: citedContexts,
  });

  // Derive the embedded data scope from the actual cited and
  // ranked context. The AI summary draws from every context, not
  // only those it explicitly cited, so include all of them. Org-
  // scoped hit types (case-law, contact) have no workspaceId and
  // are correctly excluded — RLS for those is enforced elsewhere.
  const dataWorkspaceIds = uniqueWorkspaceIds(
    contextsResult
      .map((context) => extractHitWorkspaceId(context.hit))
      .filter((id): id is SafeId<"workspace"> => id !== null),
  );

  const insertResult = await safeDb(async (tx) => {
    await tx.insert(chatThreads).values({
      id: threadId,
      organizationId,
      title: body.title,
      userId,
      // Search summaries can span multiple workspaces, so the
      // thread's own workspaceId stays null. Tenant gating happens
      // via dataWorkspaceIds — the row is invisible (RLS) the
      // moment the user loses access to any contributing matter.
      workspaceId: null,
      dataWorkspaceIds,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(chatMessages).values([
      {
        id: userMessageId,
        threadId,
        workspaceId: null,
        userId,
        role: "user",
        content: {
          version: 1,
          data: [{ type: "text", text: userText }],
        },
        createdAt: now,
      },
      {
        id: assistantMessageId,
        threadId,
        workspaceId: null,
        userId,
        role: "assistant",
        content: {
          version: 1,
          data: [
            { type: "text", text: assistantText },
            ...citedContexts.flatMap(toChatSourceParts),
          ],
        },
        createdAt: new Date(now.getTime() + 1),
      },
    ]);

    await recordAuditEvent(tx, [
      {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
        resourceId: threadId,
        workspaceId: null,
        metadata: {
          source: "search-summary",
          dataWorkspaceIds,
        },
      },
      {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.CHAT_MESSAGE,
        resourceId: userMessageId,
        workspaceId: null,
        metadata: { threadId, role: "user" },
      },
      {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.CHAT_MESSAGE,
        resourceId: assistantMessageId,
        workspaceId: null,
        metadata: { threadId, role: "assistant" },
      },
    ]);
  });

  if (insertResult.isErr()) {
    captureError(insertResult.error, {
      feature: "search.summary.chat",
      organizationId,
    });
    return status(500, { message: "Failed to create chat thread" });
  }

  // Index the freshly seeded summary thread so it is findable in
  // global search. Fire-and-forget: indexing must not fail the create.
  upsertChatThreadSearchDocument(threadId).catch(captureError);

  return { threadId };
};

const loadSummaryContexts = async ({
  accessibleWorkspaceIds,
  filters,
  organizationId,
  userId,
  search = searchGlobal,
  selectedWorkspaceIds,
  scopedDb,
}: {
  accessibleWorkspaceIds: SafeId<"workspace">[];
  filters: Pick<
    SummarizeSearchBody,
    | "editedByUserIds"
    | "limit"
    | "mimeTypes"
    | "query"
    | "types"
    | "updatedFrom"
    | "updatedTo"
  >;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  search?: typeof searchGlobal;
  selectedWorkspaceIds: readonly SafeId<"workspace">[];
  scopedDb: ScopedDb;
}) => {
  const types = citableSummaryTypes(filters.types);
  if (filters.types.length > 0 && types.length === 0) {
    return [];
  }

  const searchResult = await search({
    query: filters.query,
    organizationId,
    userId,
    accessibleWorkspaceIds,
    selectedWorkspaceIds,
    types,
    editedByUserIds: filters.editedByUserIds,
    mimeTypes: filters.mimeTypes,
    updatedFrom: filters.updatedFrom,
    updatedTo: filters.updatedTo,
    limit: filters.limit ?? SEARCH_SUMMARY_RESULT_LIMIT,
  });

  return await buildSearchResultContexts({
    hits: searchResult.hits,
    organizationId,
    accessibleWorkspaceIds,
    scopedDb,
  });
};

const toModelSearchResultContext = (context: SearchResultContext) => ({
  number: context.number,
  id: context.id,
  title: context.title,
  type: context.type,
  headline: context.headline,
  content: context.content,
});

const citationHref = (context: SearchResultContext): string | null => {
  const hit = context.hit;
  if (hit.type === "case-law") {
    return `#stella-decision=${hit.decisionId}`;
  }
  if (hit.type === "matter") {
    return `#stella-workspace=${hit.workspaceId}`;
  }
  if (hit.type === "contact") {
    return null;
  }
  return `#stella-entity=${hit.workspaceId}:${hit.entityId}`;
};

const buildChatSummaryText = ({
  citations,
  contexts,
  summary,
  title,
}: {
  citations: readonly SearchSummaryCitation[];
  contexts: readonly SearchResultContext[];
  summary: string;
  title: string;
}): string => {
  const contextByNumber = new Map(
    contexts.map((context) => [context.number, context]),
  );
  const sourceLines = citations.map((citation) => {
    const label = `[${citation.number}] ${citation.title}`;
    const linked = citation.href ? `[${label}](${citation.href})` : label;
    const excerpt = contextByNumber.get(citation.number)?.content;
    return `- ${linked}: ${citation.reason}${
      excerpt ? `\n  Excerpt: ${truncate(excerpt, 1200)}` : ""
    }`;
  });

  return [`## ${title}`, summary, "### Sources", ...sourceLines].join("\n\n");
};

const extractHitWorkspaceId = (
  hit: CitableSearchHit,
): SafeId<"workspace"> | null => {
  if (hit.type === "case-law" || hit.type === "contact") {
    return null;
  }
  return brandPersistedWorkspaceId(hit.workspaceId);
};

const uniqueWorkspaceIds = (
  ids: readonly SafeId<"workspace">[],
): SafeId<"workspace">[] => Array.from(new Set(ids));

const toChatSourceParts = (context: SearchResultContext) => {
  const hit = context.hit;
  if (
    hit.type === "case-law" ||
    hit.type === "contact" ||
    hit.type === "matter"
  ) {
    return [];
  }

  return [
    {
      type: "data-stella-source-document" as const,
      data: {
        entityId: hit.entityId,
        kind: hit.type,
        mimeType: hit.mimeType,
        title: hit.title,
        workspaceId: hit.workspaceId,
      },
    },
  ];
};

type BuildSearchResultContextsOptions = {
  hits: readonly GlobalSearchHit[];
  organizationId: SafeId<"organization">;
  accessibleWorkspaceIds: SafeId<"workspace">[];
  scopedDb: ScopedDb;
};

const buildSearchResultContexts = async ({
  hits,
  organizationId,
  accessibleWorkspaceIds,
  scopedDb,
}: BuildSearchResultContextsOptions): Promise<SearchResultContext[]> => {
  const contexts: SearchResultContext[] = [];
  let remainingChars = SEARCH_CONTEXT_TOTAL_CHARS;
  let contextNumber = 0;

  for (const hit of hits) {
    if (remainingChars <= 0) {
      break;
    }

    // Chat threads are not citable summary sources; skip them so the
    // remaining work narrows to the citable variants.
    if (hit.type === "chat") {
      continue;
    }

    const content = await loadSearchHitContent({
      hit,
      organizationId,
      accessibleWorkspaceIds,
      scopedDb,
    });
    const clipped = truncate(
      compactContent(content),
      Math.min(remainingChars, SEARCH_CONTEXT_CHARS_PER_RESULT),
    );
    if (!clipped) {
      continue;
    }

    contextNumber += 1;
    contexts.push({
      id: hit.id,
      number: contextNumber,
      title: hit.title,
      type: hit.type,
      headline: hit.headline,
      content: clipped,
      hit,
    });
    remainingChars -= clipped.length;
  }

  return contexts;
};

type LoadSearchHitContentOptions = {
  hit: CitableSearchHit;
  organizationId: SafeId<"organization">;
  accessibleWorkspaceIds: SafeId<"workspace">[];
  scopedDb: ScopedDb;
};

const loadSearchHitContent = async ({
  hit,
  organizationId,
  accessibleWorkspaceIds,
  scopedDb,
}: LoadSearchHitContentOptions): Promise<string> => {
  if (hit.type === "case-law") {
    const rows = await scopedDb((tx) =>
      tx
        .select({ searchableText: caseLawSearchDocuments.searchableText })
        .from(caseLawSearchDocuments)
        .where(
          eq(
            caseLawSearchDocuments.decisionId,
            brandPersistedCaseLawDecisionId(hit.decisionId),
          ),
        )
        .limit(1),
    );
    return compactContent(rows.at(0)?.searchableText);
  }

  if (hit.type === "contact") {
    const rows = await scopedDb((tx) =>
      tx
        .select({ searchableText: contactSearchDocuments.searchableText })
        .from(contactSearchDocuments)
        .where(
          and(
            eq(contactSearchDocuments.organizationId, organizationId),
            eq(
              contactSearchDocuments.contactId,
              brandPersistedContactId(hit.contactId),
            ),
          ),
        )
        .limit(1),
    );
    return compactContent(rows.at(0)?.searchableText);
  }

  const hitWorkspaceId = brandPersistedWorkspaceId(hit.workspaceId);
  if (!accessibleWorkspaceIds.includes(hitWorkspaceId)) {
    return "";
  }

  if (hit.type === "matter") {
    const rows = await scopedDb((tx) =>
      tx
        .select({ searchableText: workspaceSearchDocuments.searchableText })
        .from(workspaceSearchDocuments)
        .where(
          and(
            eq(workspaceSearchDocuments.organizationId, organizationId),
            eq(workspaceSearchDocuments.workspaceId, hitWorkspaceId),
          ),
        )
        .limit(1),
    );
    return compactContent(rows.at(0)?.searchableText);
  }

  const rows = await scopedDb((tx) =>
    tx
      .select({ searchableText: searchDocuments.searchableText })
      .from(searchDocuments)
      .where(
        and(
          eq(searchDocuments.organizationId, organizationId),
          eq(searchDocuments.workspaceId, hitWorkspaceId),
          eq(searchDocuments.entityId, brandPersistedEntityId(hit.entityId)),
        ),
      )
      .limit(1),
  );
  return compactContent(rows.at(0)?.searchableText);
};
