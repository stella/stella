import { panic, Result } from "better-result";
import * as v from "valibot";

import { readEntityByIdHandler } from "@/api/handlers/entities/get";
import type { SafeId } from "@/api/lib/branded-types";
import {
  loadCurrentExtractedContents,
  loadCurrentExtractedSources,
} from "@/api/lib/document-content-provenance";
import { LIMITS } from "@/api/lib/limits";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import {
  brandPersistedEntityId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import { decodeCursor } from "@/api/lib/search/cursor";
import { getSearchReader } from "@/api/lib/search/provider";
import {
  type AuthorizedWorkspaceIds,
  authorizedWorkspaceIds,
  type AuthorizedWorkspaceReadError,
} from "@/api/lib/workspaces/authorized-workspace-ids";
import {
  COMPAT_FETCH_OUTPUT_SCHEMA,
  COMPAT_SEARCH_OUTPUT_SCHEMA,
} from "@/api/mcp/compat-contract";
import {
  EMPTY_CORPUS_CURSORS,
  hasMoreCorpusPages,
  resolveCompatCorpusCountries,
  searchCompatCorpus,
} from "@/api/mcp/compat-corpus";
import {
  COMPAT_ID_HINT,
  COMPAT_ID_VOCABULARY,
  compatIdInputSchema,
  decodeCompatId,
} from "@/api/mcp/compat-ids";
import {
  COMPAT_SEARCH_CURSOR_MAX_LENGTH,
  compatCorpusFetchResponse,
  compatSearchCursorError,
  compatSearchPageLimitResult,
  type CompatSearchPosition,
  decodeCompatSearchCursor,
  encodeCompatSearchCursor,
  invalidCompatIdResult,
  publicLawDisabledResult,
} from "@/api/mcp/compat-shared";
import type { McpRequestResources } from "@/api/mcp/context";
import { isMcpToolFeatureEnabled } from "@/api/mcp/tool-feature";
import type {
  McpCompatSearchResult,
  McpToolDefinition,
  McpToolHandler,
} from "@/api/mcp/tool-types";
import { defineMcpToolSet } from "@/api/mcp/tool-types";
import {
  buildDocumentUrl,
  buildMatterUrl,
  cursorInput,
  DEFAULT_COMPAT_SEARCH_LIMIT,
  ensureWorkspaceAccess,
  errorResult,
  internalFailureResult,
  MCP_CONTENT_MAX_CHARS,
  notFoundResult,
  nullAsAbsent,
  validationErrorResult,
} from "@/api/mcp/tool-utils";
import {
  defineMcpToolOutput,
  defineValibotMcpTool,
} from "@/api/mcp/valibot-tool-definition";
import type { AuthorizedMcpRequestContext } from "@/api/mcp/write-tool-authority";
import { openMcpRead } from "@/api/mcp/write-tool-authority";

type CompatToolName = "fetch" | "search";

type FetchableEntity = {
  entityId: string;
  fieldId: string | null;
  workspaceId: SafeId<"workspace">;
};

type CompatFetchPayload = {
  charCount: number | null;
  text: string;
  title: string;
  truncated: boolean;
  workspaceId: SafeId<"workspace">;
};

const PUBLIC_LAW_FEATURE = "FEATURE_PUBLIC_LAW";

/**
 * The one compat path into matter content: the workspace check and the
 * content read share one scoped transaction, and any failure inside it,
 * thrown or returned, comes back as an error Result for the internal
 * failure envelope.
 */
const readAuthorizedMatterContent = async <T>(
  context: McpRequestResources,
  read: (
    tx: Parameters<Parameters<McpRequestResources["scopedDb"]>[0]>[0],
    workspaceIds: AuthorizedWorkspaceIds,
  ) => Promise<T>,
): Promise<Result<T, unknown>> =>
  (
    await Result.tryPromise({
      try: async () =>
        await context.scopedDb(
          async (tx): Promise<Result<T, AuthorizedWorkspaceReadError>> => {
            const workspaceIds = await authorizedWorkspaceIds(tx, {
              organizationId: context.organizationId,
              workspaceIds: context.accessibleWorkspaceIds,
            });
            if (workspaceIds.isErr()) {
              return Result.err(workspaceIds.error);
            }
            return Result.ok(await read(tx, workspaceIds.value));
          },
        ),
      catch: (cause) => cause,
    })
  ).andThen((inner) => inner);

const getFetchableEntityMap = async ({
  context,
  entityIds,
}: {
  context: AuthorizedMcpRequestContext;
  entityIds: string[];
}) => {
  if (entityIds.length === 0) {
    return Result.ok(new Map<string, FetchableEntity>());
  }

  const safeEntityIds = entityIds.map(brandPersistedEntityId);

  const loaded = await readAuthorizedMatterContent(
    context,
    async (tx, workspaceIds) =>
      await loadCurrentExtractedSources(tx, {
        entityIds: safeEntityIds,
        organizationId: context.organizationId,
        workspaceIds,
      }),
  );
  if (loaded.isErr()) {
    return loaded;
  }
  const fetchableEntityMap = new Map<string, FetchableEntity>();
  for (const row of loaded.value) {
    fetchableEntityMap.set(row.entityId, {
      entityId: row.entityId,
      fieldId: row.sourceFieldId,
      workspaceId: brandPersistedWorkspaceId(row.workspaceId),
    });
  }

  return Result.ok(fetchableEntityMap);
};

const getCompatSearchHits = (result: unknown): unknown[] => {
  if (typeof result !== "object" || result === null || !("hits" in result)) {
    return [];
  }

  const { hits } = result;
  return Array.isArray(hits) ? hits : [];
};

const getCompatSearchEntityIds = (hits: readonly unknown[]) =>
  hits.flatMap((hit) => {
    if (typeof hit !== "object" || hit === null || !("entityId" in hit)) {
      return [];
    }

    return typeof hit.entityId === "string" ? [hit.entityId] : [];
  });

const mapCompatSearchResults = ({
  fetchableMap,
  hits,
}: {
  fetchableMap: Map<string, FetchableEntity>;
  hits: unknown[];
}) =>
  hits.flatMap((hit): McpCompatSearchResult[] => {
    if (typeof hit !== "object" || hit === null) {
      return [];
    }

    const entityId = "entityId" in hit ? hit.entityId : undefined;
    const title = "name" in hit ? hit.name : undefined;
    const workspaceId = "workspaceId" in hit ? hit.workspaceId : undefined;

    if (
      typeof entityId !== "string" ||
      typeof title !== "string" ||
      typeof workspaceId !== "string"
    ) {
      return [];
    }

    const fetchableEntity = fetchableMap.get(entityId);
    if (!fetchableEntity) {
      return [];
    }

    const url =
      fetchableEntity.fieldId === null
        ? buildMatterUrl(fetchableEntity.workspaceId)
        : buildDocumentUrl({
            entityId,
            fieldId: fetchableEntity.fieldId,
            workspaceId: fetchableEntity.workspaceId,
          });

    return [
      {
        kind: "matter",
        id: entityId,
        title,
        url,
        workspaceId: fetchableEntity.workspaceId,
      },
    ];
  });

const getCompatFetchPayload = ({
  entityId,
  result,
}: {
  entityId: string;
  result: unknown;
}): CompatFetchPayload | null => {
  const workspaceId =
    typeof result === "object" &&
    result !== null &&
    "workspaceId" in result &&
    typeof result.workspaceId === "string"
      ? brandPersistedWorkspaceId(result.workspaceId)
      : null;
  const title =
    typeof result === "object" &&
    result !== null &&
    "name" in result &&
    typeof result.name === "string" &&
    result.name.length > 0
      ? result.name
      : entityId;
  const text =
    typeof result === "object" &&
    result !== null &&
    "text" in result &&
    typeof result.text === "string"
      ? result.text
      : null;

  if (workspaceId === null || text === null) {
    return null;
  }

  const charCount =
    typeof result === "object" &&
    result !== null &&
    "charCount" in result &&
    typeof result.charCount === "number"
      ? result.charCount
      : null;
  const truncated =
    typeof result === "object" &&
    result !== null &&
    "truncated" in result &&
    typeof result.truncated === "boolean"
      ? result.truncated
      : false;

  return {
    charCount,
    text,
    title,
    truncated,
    workspaceId,
  };
};

const compatSearchArgsSchema = nullAsAbsent(
  v.strictObject({
    query: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(LIMITS.searchQueryMaxLength),
      v.description("Search query"),
    ),
    cursor: cursorInput({
      maxLength: COMPAT_SEARCH_CURSOR_MAX_LENGTH,
      description:
        "Opaque cursor from a previous search call to fetch the next page",
    }),
  }),
);

const compatFetchArgsSchema = nullAsAbsent(
  v.strictObject({
    id: compatIdInputSchema(`Result id from search. ${COMPAT_ID_VOCABULARY}`),
    cursor: cursorInput({
      description:
        "Opaque cursor from a previous fetch call to read the next window of text",
    }),
  }),
);

export const resolveCompatFetchReadClass = (args: unknown) => {
  if (
    typeof args !== "object" ||
    args === null ||
    !("id" in args) ||
    typeof args.id !== "string"
  ) {
    return undefined;
  }
  const target = decodeCompatId(args.id);
  if (target === null) {
    return undefined;
  }
  switch (target.kind) {
    case "document":
      return "tenant";
    case "decision":
    case "statute":
      return "public";
    default:
      target satisfies never;
      return panic("Unhandled compat read target");
  }
};

const COMPAT_TOOL_DEFINITIONS = [
  defineValibotMcpTool({
    consumesServices: false,
    annotations: {
      title: "Search",
      destructiveHint: false,
      readOnlyHint: true,
      openWorldHint: false,
    },
    access: "read",
    permissions: openMcpRead(
      "searches only public law and caller-accessible matter records",
    ),
    readClass: "both",
    anonymized: {
      exposure: "anonymize",
      textFields: ["title"],
      description:
        "Search anonymized knowledge across accessible matters using the " +
        "OpenAI-compatible search tool shape. Where this deployment enables the public legal " +
        "corpus, the same query also returns case-law decisions and statutes, which are " +
        `published law and are returned as written. ${COMPAT_ID_VOCABULARY} Pass an id back to fetch verbatim.`,
    },
    description:
      "Search knowledge across accessible matters using the OpenAI-compatible " +
      "search tool shape. Where this deployment enables the public legal corpus, the same " +
      "query also returns case-law decisions and statutes from every jurisdiction the corpus " +
      `holds, the organization's practice jurisdictions first. ${COMPAT_ID_VOCABULARY} Pass an id back to fetch verbatim. ` +
      "Use legal citation `url` for the reader and `source_url` for the publisher.",
    inputSchema: compatSearchArgsSchema,
    name: "search",
    scope: "stella:search",
  }),
  defineValibotMcpTool({
    consumesServices: false,
    annotations: {
      title: "Fetch",
      destructiveHint: false,
      readOnlyHint: true,
      openWorldHint: false,
    },
    access: "read",
    permissions: openMcpRead(
      "fetches only public law or caller-accessible matter records",
    ),
    readClass: resolveCompatFetchReadClass,
    anonymized: {
      exposure: "anonymize",
      textFields: ["title", "text"],
      description:
        "Fetch one search result by id using the OpenAI-compatible fetch tool " +
        `shape. ${COMPAT_ID_VOCABULARY} A matter document is returned anonymized; a ` +
        "decision or a statute is published law and is returned as written. Long text is " +
        "returned in windows; pass the returned nextCursor back as cursor to read more. " +
        "Use legal citation `url` for the reader and `source_url` for the publisher.",
    },
    description:
      "Fetch one search result by id using the OpenAI-compatible fetch tool " +
      `shape. ${COMPAT_ID_VOCABULARY} \`metadata.kind\` says which of the three the ` +
      "answer is. Long text is returned in windows; pass the returned nextCursor back " +
      "as cursor to read more. " +
      "Use legal citation `url` for the reader and `source_url` for the publisher.",
    inputSchema: compatFetchArgsSchema,
    name: "fetch",
    scope: "stella:read",
  }),
] as const satisfies readonly McpToolDefinition[];

/**
 * The position a cursor names with the corpus gate closed: this pair reads
 * matters alone, so the cursor is the knowledge provider's own, exactly as it
 * was before the corpus reached the pair. Rejecting an undecodable one matters
 * either way, because the provider treats a malformed cursor as no cursor and
 * silently returns the first page, which would duplicate hits or loop a
 * paginating client.
 */
const matterOnlyPosition = (
  cursor: string | undefined,
): CompatSearchPosition | null => {
  if (cursor === undefined) {
    return { matter: undefined, corpus: EMPTY_CORPUS_CURSORS };
  }
  return decodeCursor(cursor) === null
    ? null
    : { matter: cursor, corpus: EMPTY_CORPUS_CURSORS };
};

type MatterSearchPage = {
  /** Passed through as the provider spelled it; absent is its own answer. */
  nextCursor: string | null | undefined;
  results: McpCompatSearchResult[];
};

/** What a matter source whose cursor said its pages ended answers with. */
const EXHAUSTED_MATTER_PAGE: MatterSearchPage = {
  nextCursor: null,
  results: [],
};

/**
 * One page of matter knowledge.
 *
 * Request exactly the page size and pass the provider cursor through so
 * pagination stays correct: the keyset cursor tracks the provider's hit
 * position, so over-fetching and post-filtering would desync it and skip
 * results. Non-fetchable hits are dropped, so a page may be smaller than the
 * page size; callers keep paging while `nextCursor` is non-null.
 */
const searchMatterKnowledge = async ({
  context,
  cursor,
  query,
}: {
  context: AuthorizedMcpRequestContext;
  cursor: string | undefined;
  query: string;
}): Promise<Result<MatterSearchPage, unknown>> => {
  const page = await (
    context.testDependencies?.getSearchReader ?? getSearchReader
  )(context.scopedDb).search({
    query,
    organizationId: context.organizationId,
    workspaceIds: context.accessibleWorkspaceIds,
    limit: normalizeTenantPageLimit(DEFAULT_COMPAT_SEARCH_LIMIT),
    ...(cursor === undefined ? {} : { cursor }),
  });

  const hits = getCompatSearchHits({
    hits: page.hits.map((hit) => ({
      entityId: hit.entityId,
      workspaceId: hit.workspaceId,
      name: hit.title,
    })),
  });
  const fetchableMap = await getFetchableEntityMap({
    context,
    entityIds: getCompatSearchEntityIds(hits),
  });
  if (fetchableMap.isErr()) {
    return fetchableMap;
  }

  return Result.ok({
    nextCursor: page.nextCursor,
    results: mapCompatSearchResults({ fetchableMap: fetchableMap.value, hits }),
  });
};

const handleCompatSearchTool: McpToolHandler<
  v.InferInput<typeof COMPAT_SEARCH_OUTPUT_SCHEMA>
> = async ({ args, context }) => {
  const parsed = v.safeParse(compatSearchArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const { cursor, query } = parsed.output;
  const corpusEnabled = isMcpToolFeatureEnabled(PUBLIC_LAW_FEATURE);

  const position = corpusEnabled
    ? decodeCompatSearchCursor(cursor)
    : matterOnlyPosition(cursor);
  if (position === null) {
    return compatSearchCursorError(cursor ?? "");
  }

  const pageLimitResult = corpusEnabled
    ? compatSearchPageLimitResult("tenant")
    : null;
  if (pageLimitResult !== null) {
    return pageLimitResult;
  }

  const matterResult =
    position.matter === null
      ? Result.ok(EXHAUSTED_MATTER_PAGE)
      : await searchMatterKnowledge({
          context,
          cursor: position.matter,
          query,
        });
  if (matterResult.isErr()) {
    return internalFailureResult(matterResult.error);
  }
  const matter = matterResult.value;

  if (!corpusEnabled) {
    return {
      egress: "compatSearch",
      nextCursor: matter.nextCursor,
      results: matter.results,
    };
  }

  const corpus = await searchCompatCorpus({
    context,
    countries: await resolveCompatCorpusCountries(context),
    cursors: position.corpus,
    query,
  });
  if (corpus.type === "failed") {
    return corpus.result;
  }

  // Matter hits first, then decisions, then statutes: a caller asking this
  // pair about its own matters must not have the answer pushed below public
  // law it did not ask for.
  // The merged cursor has no "not asked yet" state to carry, so a provider
  // that answered without one has ended: `undefined` and `null` are the same
  // position to a caller paging this page.
  const matterNext = matter.nextCursor ?? null;
  const exhausted = matterNext === null && !hasMoreCorpusPages(corpus.cursors);

  // Return the full per-workspace results (title included); the egress pipeline
  // strips `workspaceId` in default mode and anonymizes matter titles in
  // anonymized mode. The handler never branches on mode.
  return {
    egress: "compatSearch",
    paginationOutcome: corpus.paginationOutcome,
    nextCursor: exhausted
      ? null
      : encodeCompatSearchCursor({
          matter: matterNext,
          corpus: corpus.cursors,
        }),
    results: [...matter.results, ...corpus.results],
  };
};

/** Resolves the fetch target with the same schema and id reader as dispatch. */
export const compatFetchConsumesServices = (args: unknown): boolean => {
  const parsed = v.safeParse(compatFetchArgsSchema, args);
  if (!parsed.success) {
    return true;
  }
  const id = decodeCompatId(parsed.output.id);
  if (id === null) {
    return true;
  }
  switch (id.kind) {
    case "document":
      return false;
    case "decision":
    case "statute":
      return false;
    default: {
      id satisfies never;
      return panic("Unclassified compat fetch target");
    }
  }
};

const handleCompatFetchTool: McpToolHandler<
  v.InferInput<typeof COMPAT_FETCH_OUTPUT_SCHEMA>
> = async ({ args, context }) => {
  const parsed = v.safeParse(compatFetchArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues, COMPAT_ID_HINT);
  }
  const { cursor, id: rawId } = parsed.output;
  const compatId = decodeCompatId(rawId);
  if (compatId === null) {
    return invalidCompatIdResult(COMPAT_ID_HINT);
  }

  if (compatId.kind !== "document") {
    if (!isMcpToolFeatureEnabled(PUBLIC_LAW_FEATURE)) {
      return publicLawDisabledResult(PUBLIC_LAW_FEATURE);
    }
    return await compatCorpusFetchResponse({ compatId, context, cursor });
  }

  const rawEntityId = compatId.entityId;
  const entityId = brandPersistedEntityId(rawEntityId);

  if (context.accessibleWorkspaceIds.length === 0) {
    return errorResult("Document content is unavailable");
  }

  const loaded = await readAuthorizedMatterContent(
    context,
    async (tx, workspaceIds) =>
      await loadCurrentExtractedContents(tx, {
        entityIds: [entityId],
        organizationId: context.organizationId,
        workspaceIds,
      }),
  );
  if (loaded.isErr()) {
    return internalFailureResult(loaded.error);
  }
  const row = loaded.value.at(0);

  if (!row) {
    return errorResult("Document content is unavailable");
  }

  const text = row.text;
  // Keep the full decrypted text here; windowing happens in the egress
  // pipeline so anonymized fetches anonymize the whole document before slicing
  // (slicing raw text first could split an entity name across the window
  // boundary and leak its prefix).
  const result = {
    charCount: row.charCount,
    name: row.name,
    text,
    truncated: false,
    workspaceId: row.workspaceId,
  };

  const fetchPayload = getCompatFetchPayload({ entityId: rawEntityId, result });
  if (!fetchPayload) {
    return errorResult("Document content is unavailable");
  }

  const workspaceAccess = ensureWorkspaceAccess({
    context,
    workspaceId: fetchPayload.workspaceId,
  });
  if (!workspaceAccess) {
    return notFoundResult("Matter not found or not accessible");
  }

  const entityResult = await Result.gen(() =>
    readEntityByIdHandler({
      safeDb: context.safeDb,
      workspaceId: workspaceAccess,
      entityId,
    }),
  );

  let url = buildMatterUrl(fetchPayload.workspaceId);
  if (Result.isOk(entityResult)) {
    const entity = entityResult.value;
    const fileField = entity.fields.find(
      (field: { content: { type: string } }) => field.content.type === "file",
    );
    if (fileField) {
      url = buildDocumentUrl({
        entityId: rawEntityId,
        fieldId: fileField.id,
        workspaceId: workspaceAccess,
      });
    }
  }

  // Hand the full document to the egress pipeline: it anonymizes title + text
  // (anonymized mode) before windowing, then serializes. No mode branch here.
  return {
    egress: "compatFetch",
    cursor,
    id: rawId,
    maxChars: MCP_CONTENT_MAX_CHARS,
    subject: { kind: "document", workspaceId: fetchPayload.workspaceId },
    text: fetchPayload.text,
    title: fetchPayload.title,
    url,
  };
};

export const COMPAT_TOOL_HANDLERS = {
  fetch: handleCompatFetchTool,
  search: handleCompatSearchTool,
} satisfies Record<CompatToolName, McpToolHandler>;

export const COMPAT_TOOL_SET = defineMcpToolSet(
  COMPAT_TOOL_DEFINITIONS,
  COMPAT_TOOL_HANDLERS,
  {
    fetch: defineMcpToolOutput(COMPAT_FETCH_OUTPUT_SCHEMA),
    search: defineMcpToolOutput(COMPAT_SEARCH_OUTPUT_SCHEMA),
  },
);
