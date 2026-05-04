import type { GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
import { valibotSchema } from "@ai-sdk/valibot";
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
  searchDocuments,
  workspaceSearchDocuments,
} from "@/api/db/schema";
import { resolveSelectedWorkspaceIds } from "@/api/handlers/search/search";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import {
  getModelForRole,
  getTemperatureForRole,
  requireAIAvailable,
} from "@/api/lib/ai-models";
import { captureError } from "@/api/lib/analytics";
import { createAIAnalyticsCallbacks } from "@/api/lib/analytics/ai";
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
import { searchGlobal } from "@/api/lib/search/index-global";
import {
  buildSearchTsQuery,
  validateStellaSearchQuery,
} from "@/api/lib/search/query";
import type { GlobalSearchHit } from "@/api/lib/search/types";
import { GLOBAL_SEARCH_RESULT_TYPES } from "@/api/lib/search/types";

const SEARCH_SUMMARY_RESULT_LIMIT = 5;
const SEARCH_CONTEXT_CHARS_PER_RESULT = 3000;
const SEARCH_CONTEXT_TOTAL_CHARS = 14_000;
const SEARCH_REFINE_MAX_ATTEMPTS = 3;
const SEARCH_SUMMARY_CITATION_LIMIT = 5;

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
  scopedDb: ScopedDb;
};

type SearchSummaryContext = SearchAIContext & {
  accessibleWorkspaceIds: SafeId<"workspace">[];
};

type SearchResultContext = {
  id: string;
  number: number;
  title: string;
  type: string;
  headline: string | null;
  content: string;
  hit: GlobalSearchHit;
};

type SearchSummaryCitation = {
  href: string | null;
  id: string;
  number: number;
  title: string;
  type: string;
  reason: string;
};

type SearchSummaryChatContext = {
  accessibleWorkspaceIds: SafeId<"workspace">[];
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  userId: SafeId<"user">;
};

const SEARCH_REFINE_SYSTEM = `You rewrite a legal workspace search request into Stella's boolean search syntax.

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
  return value.replace(/\s+/g, " ").trim();
};

const truncate = (text: string, maxLength: number): string =>
  text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;

const googleMinimalThinking = () => ({
  google: {
    thinkingConfig: {
      thinkingLevel: "minimal",
      includeThoughts: false,
    },
  } satisfies GoogleGenerativeAIProviderOptions,
});

type GenerateRefinedSearchQueryOptions = {
  attempt: number;
  body: RefineSearchBody;
  lastValidationError: string | null;
  orgAIConfig: OrgAIConfig | null;
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
  orgAIConfig,
  stepCallbacks,
}: GenerateRefinedSearchQueryOptions) =>
  await Result.tryPromise({
    try: async () =>
      await generateText({
        model: getModelForRole("fast", orgAIConfig),
        temperature: getTemperatureForRole("fast"),
        system: SEARCH_REFINE_SYSTEM,
        prompt: JSON.stringify({
          attempt,
          locale: body.locale ?? null,
          query: body.query,
          previousValidationError: lastValidationError,
        }),
        output: Output.object({
          schema: valibotSchema(refineSearchOutputSchema),
        }),
        maxOutputTokens: 180,
        providerOptions: googleMinimalThinking(),
        abortSignal: AbortSignal.timeout(20_000),
        ...stepCallbacks,
      }),
    catch: (error: unknown) => error,
  });

export const refineSearchQuery = async ({
  body,
  organizationId,
  orgAIConfig,
  scopedDb,
}: SearchAIContext & {
  body: RefineSearchBody;
}) => {
  const gate = requireAIAvailable(orgAIConfig);
  if (gate.isErr()) {
    return status(403, { message: gate.error.message });
  }

  const aiAnalytics = createAIAnalyticsCallbacks({
    feature: "search.refine",
    properties: { organization_id: organizationId },
    traceId: Bun.randomUUIDv7(),
  });

  let lastValidationError: string | null = null;

  for (let attempt = 1; attempt <= SEARCH_REFINE_MAX_ATTEMPTS; attempt++) {
    const result = await generateRefinedSearchQuery({
      attempt,
      body,
      lastValidationError,
      orgAIConfig,
      stepCallbacks: aiAnalytics.stepCallbacks,
    });

    if (result.isErr()) {
      aiAnalytics.captureError(result.error);
      return status(502, { message: "Failed to improve search query" });
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
      "PostgreSQL rejected the generated tsquery. Use valid Stella syntax with balanced operators and searchable terms.";
  }

  return status(502, { message: "Failed to improve search query" });
};

export const summarizeSearchResults = async ({
  body,
  organizationId,
  accessibleWorkspaceIds,
  orgAIConfig,
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
    feature: "search.summary",
    properties: {
      organization_id: organizationId,
      result_count: String(contextsResult.length),
    },
    traceId: Bun.randomUUIDv7(),
  });

  const result = await Result.tryPromise({
    try: async () =>
      await generateText({
        model: getModelForRole("fast", orgAIConfig),
        temperature: getTemperatureForRole("fast"),
        system: SEARCH_SUMMARY_SYSTEM,
        prompt: JSON.stringify({
          locale: body.locale ?? "en",
          originalQuery: body.originalQuery ?? body.query,
          searchQuery: body.query,
          results: contextsResult.map(toModelSearchResultContext),
        }),
        output: Output.object({
          schema: valibotSchema(searchSummaryOutputSchema),
        }),
        maxOutputTokens: 700,
        providerOptions: googleMinimalThinking(),
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
    return status(502, { message: "Failed to summarize search results" });
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
  userId,
}: SearchSummaryChatContext & {
  body: SearchSummaryChatBody;
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
    selectedWorkspaceIds: resolved.ids,
    scopedDb,
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
  });

  if (insertResult.isErr()) {
    captureError(insertResult.error, {
      feature: "search.summary.chat",
      organizationId,
    });
    return status(500, { message: "Failed to create chat thread" });
  }

  return { threadId };
};

const loadSummaryContexts = async ({
  accessibleWorkspaceIds,
  filters,
  organizationId,
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
  selectedWorkspaceIds: readonly SafeId<"workspace">[];
  scopedDb: ScopedDb;
}) => {
  const searchResult = await searchGlobal({
    query: filters.query,
    organizationId,
    accessibleWorkspaceIds,
    selectedWorkspaceIds,
    types: filters.types,
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
  hit: GlobalSearchHit,
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
  hit: GlobalSearchHit;
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
