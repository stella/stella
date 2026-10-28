import { panic } from "better-result";
import * as v from "valibot";

import { AGENT_INPUT_NORMALIZATION_KIND } from "@stll/agent-input";
import { RESOURCE_TYPE, resourceRef } from "@stll/api-contract";
import { apiDateSchema } from "@stll/api-contract/api-date";
import {
  LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT,
  LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_MESSAGE,
} from "@stll/api-contract/legislation-expression";
import type { LegislationInconsistentVersion } from "@stll/api-contract/legislation-expression";
import {
  PUBLIC_LEGISLATION_COUNTRIES,
  publicLegislationCountry,
} from "@stll/api-contract/legislation-publication";
import { publicCountryUnavailable } from "@stll/api-contract/public-country-capability";
import { statuteActNumber } from "@stll/api-contract/statute-act-number";
import { mapWithConcurrency } from "@stll/concurrency";
import type { Block } from "@stll/legal-ast/document-ast";
import { hasUsableAst } from "@stll/legal-ast/document-ast";
import { anchorProvisionCitation } from "@stll/legal-atlas/provision-citation-resolve";
import { STATUTE_TIMELINE_RESOURCE_URI } from "@stll/mcp-apps/resource-uri";

import type { StatuteExpressionResolution } from "@/api/handlers/legislation/by-eli";
import type { readProvisionHistoryHandler } from "@/api/handlers/legislation/provision-history";
import { extractProvisionText } from "@/api/handlers/legislation/provision-text";
import type { LegislationProvisionVersion } from "@/api/handlers/legislation/provision-versions";
import type { listStatuteVersionsHandler } from "@/api/handlers/legislation/versions";
import {
  READ_PROVISION_HISTORY_PROJECTION,
  READ_STATUTE_PROVISIONS_PROJECTION,
} from "@/api/lib/chat/legislation-result-projections";
import {
  READ_STATUTE_PROJECTION,
  SEARCH_LEGISLATION_PROJECTION,
} from "@/api/lib/chat/projections";
import { CORPUS_SEARCH_CURSOR_WITH_PHASE_MAX_LENGTH } from "@/api/lib/legal-search/corpus-search-cursor";
import { PROVISION_STATUS } from "@/api/lib/legal-search/legislation-provision-vocabulary";
import { readVersionBlocks } from "@/api/lib/legal-search/legislation-version-blocks";
import { isSearchIndexUnavailable } from "@/api/lib/legal-search/search-index-unavailable";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";
import { LIMITS } from "@/api/lib/limits";
import { projectionPayload } from "@/api/lib/projection-totality";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedLegislationDocumentId } from "@/api/lib/safe-id-boundaries";
import {
  ACTION_COST_CALL_KIND,
  actionRequestObserver,
} from "@/api/lib/usage/action-costs/context";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  countryInputSchema,
  countryNormalization,
  cursorInput,
  ELI_NORMALIZATION,
  FILTER_NORMALIZATION,
  nullAsAbsent,
  uuidInputSchema,
} from "@/api/mcp/input-schemas";
import {
  anchorInputSchema,
  eliInputSchema,
  languageInputSchema,
  READ_PROVISION_HISTORY_INPUT_NORMALIZATION,
  readProvisionHistoryArgsSchema,
} from "@/api/mcp/legislation-input";
import {
  isProvisionTextCursor,
  windowProvisionText,
} from "@/api/mcp/provision-text-window";
import type { StatuteDocument } from "@/api/mcp/public-law-handlers";
import {
  defaultListStatuteVersionsHandler,
  defaultReadLegislationProvisionVersions,
  defaultReadProvisionHistoryHandler,
  defaultReadPublicLegislationHandler,
  defaultResolveStatuteExpression,
  defaultResolveStatuteWorkVersion,
  defaultSearchLegislationHandler,
  isLegislationSearchSuccess,
  isStatuteDocument,
} from "@/api/mcp/public-law-handlers";
import { serializeAuthorizedCorpusMcpResourceName } from "@/api/mcp/resource-serialization";
import type {
  InternalToolErrorResult,
  McpToolDefinition,
  McpToolHandler,
  TypedMcpToolHandler,
} from "@/api/mcp/tool-types";
import { defineMcpToolSet } from "@/api/mcp/tool-types";
import {
  buildLegislationDocumentAppUrl,
  DEFAULT_SEARCH_LIMIT,
  errorResult,
  handlerStatusOf,
  invalidCursorResult,
  isToolErrorResult,
  legalCitationLinkFields,
  mapValibotIssues,
  MCP_CONTENT_MAX_CHARS,
  notFoundResult,
  searchIndexUnavailableResult,
  toolDataResult,
  toPlainCorpusText,
  toPlainTextSnippet,
  validationErrorResult,
  windowTextByCursor,
} from "@/api/mcp/tool-utils";
import {
  defineChatProjectionMcpToolOutput,
  defineValibotMcpTool,
} from "@/api/mcp/valibot-tool-definition";
import { openMcpRead } from "@/api/mcp/write-tool-authority";

/**
 * The stella legislation corpus as agent-facing tools: find a statute, read
 * the consolidation that applied on a date, read named provisions in bulk,
 * and follow one provision across amendments.
 *
 * Jurisdiction is data here, never a tool boundary. Every tool answers for
 * whichever jurisdictions `PUBLIC_LEGISLATION_COUNTRIES` admits, so admitting
 * one more is a corpus change and not a new tool. The BOE connector
 * (`search_boe_legislation`, `research-admin-tools.ts`) is a different thing:
 * it queries a publisher's live service rather than this corpus.
 *
 * Every read goes through the same handlers the public HTTP routes use, and
 * an ELI plus a date is resolved by the one resolver those routes share
 * (`resolveStatuteExpression`), so a tool cannot address a statute
 * differently from the reader.
 */

type LegislationToolName =
  | "search_legislation"
  | "read_statute"
  | "read_statute_provisions"
  | "read_provision_history";

/** Names the reading tool in a payload-unavailable capture. */
const PROVISION_READ_STEP = "readStatuteProvisions.corpusAst";

const ADMITTED_COUNTRIES = PUBLIC_LEGISLATION_COUNTRIES.join(", ");

/** Named because the country ask names the call to change; a census test binds
 *  this to the tool's own `name` so a rename cannot leave a stale hint. */
const SEARCH_LEGISLATION_TOOL = "search_legislation";

const FIND_THE_ELI_HINT =
  "Find the ELI with search_legislation and pass it as eli.";

const PICK_AN_ANCHOR_HINT =
  "Call read_statute for this eli and pick an anchorId from its outline.";

/** One sentence for the one reason wording is withheld, in both tools. */
const WITHHELD_WORDING_MESSAGE =
  "The source licence does not permit AI use of this wording. Read it at the statute's url instead.";

const asOfInputSchema = v.pipe(
  apiDateSchema,
  v.maxLength(10),
  v.description(
    "Read the consolidation in force on this ISO date (YYYY-MM-DD); omit it " +
      "for the text in force today.",
  ),
);

const searchLegislationArgsSchema = nullAsAbsent(
  v.strictObject({
    query: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(LIMITS.searchQueryMaxLength),
      v.description("Search query"),
    ),
    country: countryInputSchema(
      `Required corpus country. Admitted: ${ADMITTED_COUNTRIES}.`,
    ),
    document_type: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(128),
        v.description("Filter by document type"),
      ),
    ),
    status: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(32),
        v.description("Filter by publication status"),
      ),
    ),
    language: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(8),
        v.description("Filter by language code"),
      ),
    ),
    date_from: v.optional(
      v.pipe(
        apiDateSchema,
        v.maxLength(10),
        v.description(
          "Filter statutes effective from this ISO date (YYYY-MM-DD)",
        ),
      ),
    ),
    date_to: v.optional(
      v.pipe(
        apiDateSchema,
        v.maxLength(10),
        v.description(
          "Filter statutes effective up to this ISO date (YYYY-MM-DD)",
        ),
      ),
    ),
    as_of: v.optional(
      v.pipe(
        asOfInputSchema,
        v.description(
          "Search text in force on this ISO date (YYYY-MM-DD); omit it to include historical wording.",
        ),
      ),
    ),
    limit: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(LIMITS.caseLawSearchPageSizeMax),
        v.description(
          `Max results to return; defaults to ${DEFAULT_SEARCH_LIMIT}.`,
        ),
      ),
    ),
    cursor: cursorInput({
      description: "Opaque cursor from a previous search_legislation call",
      maxLength: CORPUS_SEARCH_CURSOR_WITH_PHASE_MAX_LENGTH,
    }),
  }),
);

const readStatuteArgsSchema = nullAsAbsent(
  v.strictObject({
    eli: eliInputSchema,
    language: v.optional(languageInputSchema),
    as_of: v.optional(asOfInputSchema),
    cursor: cursorInput({
      description:
        "Opaque cursor from a previous read_statute call to read the next window of statute text",
    }),
  }),
);

const provisionRequestSchema = v.strictObject({
  eli: eliInputSchema,
  anchor: anchorInputSchema,
  as_of: v.optional(asOfInputSchema),
  document_id: v.optional(
    uuidInputSchema(
      "Exact consolidation handle returned as documentId by read_provision_history",
    ),
  ),
  language: v.optional(languageInputSchema),
  text_cursor: cursorInput({
    description: "Opaque nextTextCursor from this provision and consolidation",
    issuedBy: isProvisionTextCursor,
  }),
});

const PROVISION_BATCH_MIN_ITEMS = 1;

const PROVISION_BATCH_DESCRIPTION =
  `The provisions to read, at most ${LIMITS.legislationProvisionBatchMax} per call. ` +
  "Each entry is validated and answered on its own, so a malformed or " +
  "unresolvable entry does not sink the rest: it comes back with its own " +
  "status.";

/**
 * The advertised contract: the bounded array of fully declared entries.
 *
 * The handler parses the same call in two stages (the envelope, then each
 * entry through `provisionRequestSchema` — this very schema's element), so a
 * model sees the exact entry shape here while one bad entry is answered per
 * entry rather than rejecting the batch. There is no second entry reader: the
 * element schema is shared by both stages.
 */
const readStatuteProvisionsArgsSchema = nullAsAbsent(
  v.strictObject({
    items: v.pipe(
      v.array(provisionRequestSchema),
      v.minLength(PROVISION_BATCH_MIN_ITEMS),
      v.maxLength(LIMITS.legislationProvisionBatchMax),
      v.description(PROVISION_BATCH_DESCRIPTION),
    ),
  }),
);

/** Stage one: the envelope and the array bound, entries still unread. */
const provisionsBatchEnvelopeSchema = nullAsAbsent(
  v.strictObject({
    items: v.pipe(
      v.array(v.unknown()),
      v.minLength(PROVISION_BATCH_MIN_ITEMS),
      v.maxLength(LIMITS.legislationProvisionBatchMax),
      v.description(PROVISION_BATCH_DESCRIPTION),
    ),
  }),
);

/** Stage two: one entry, through the element the advertised array declares. */
const provisionEntrySchema = nullAsAbsent(provisionRequestSchema);

const LEGISLATION_TOOL_DEFINITIONS = [
  defineValibotMcpTool({
    consumesServices: false,
    annotations: {
      title: "Search legislation",
      destructiveHint: false,
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "Search the stella legislation corpus within one country: consolidated " +
      "statutes, each with its ELI, title, language, document type, " +
      "publication status, effective date and a matched snippet. Filters: " +
      "document type, status, language, and an effective-date range (ISO " +
      "YYYY-MM-DD). `as_of` searches text in force on that date; omit it to include historical wording. " +
      "No facets are returned and `total` is not counted, so " +
      "page with the returned nextCursor instead of reasoning about a result " +
      "count. A hit is metadata only: pass its `eli` to read_statute for the " +
      "text, the outline of anchors and the consolidated versions. " +
      "Use `url` for the stella reader when served, otherwise the publisher; `source_url` is the publisher source.",
    inputSchema: searchLegislationArgsSchema,
    inputNormalization: {
      country: countryNormalization({
        spelling: "alpha-3",
        admitted: PUBLIC_LEGISLATION_COUNTRIES,
        tool: SEARCH_LEGISLATION_TOOL,
      }),
      document_type: FILTER_NORMALIZATION,
      status: FILTER_NORMALIZATION,
      language: FILTER_NORMALIZATION,
      as_of: { kind: AGENT_INPUT_NORMALIZATION_KIND.date, bound: "start" },
    },
    access: "read",
    permissions: openMcpRead("public legislation corpus"),
    readClass: "public",
    anonymized: { exposure: "passthrough" },
    // Backed by the public legislation corpus (legislationPublicReadDb), the
    // same surface the public routes gate behind the same feature flag.
    feature: "FEATURE_PUBLIC_LAW",
    name: SEARCH_LEGISLATION_TOOL,
    scope: "stella:search",
  }),
  defineValibotMcpTool({
    consumesServices: false,
    annotations: {
      title: "Read statute",
      destructiveHint: false,
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "Read one statute by ELI as it stood on a date: `as_of` picks the " +
      "consolidation in force that day, and omitting it reads the text in " +
      "force today. Returns that consolidation's metadata and validity " +
      "window, `pendingChanges` (publisher-stated future or undated effects), " +
      "`versions` (the newest page of the work's consolidations, with `amendedBy` effects), " +
      "`outline` (its heading anchors, the input read_statute_provisions " +
      "takes) on page 1, plus its plain text. Later pages omit outline and " +
      "versions; pass the " +
      "returned nextCursor back as cursor to read more. A source that bars " +
      "AI use of its wording still answers with metadata, versions and " +
      "outline, and `textWithheldReason` in place of the text. " +
      "Use `url` for the stella reader when served, otherwise the publisher; `source_url` is the publisher source.",
    inputSchema: readStatuteArgsSchema,
    inputNormalization: { eli: ELI_NORMALIZATION },
    access: "read",
    permissions: openMcpRead("public legislation corpus"),
    readClass: "public",
    anonymized: { exposure: "passthrough" },
    feature: "FEATURE_PUBLIC_LAW",
    name: "read_statute",
    scope: "stella:read",
  }),
  defineValibotMcpTool({
    consumesServices: false,
    annotations: {
      title: "Read statute provisions",
      destructiveHint: false,
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "Read statute provisions: items[] entries are { eli, anchor } with optional " +
      "as_of and language, or document_id from read_provision_history for an exact " +
      "consolidation. document_id and as_of are mutually exclusive. " +
      "Use publisher anchors from read_statute's outline (par_1729, par_1729-odst_1). " +
      "Entries return in input order: found carries text; invalid, not_found, " +
      "uncovered_date (no applicable consolidation, including inconsistent publisher dates), " +
      "provision_not_found and text_withheld (AI use barred) carry messages. " +
      "Continue long text with nextTextCursor as text_cursor on the same entry until null. " +
      "url opens the stella reader when served, otherwise the publisher; source_url is the publisher source.",
    inputSchema: readStatuteProvisionsArgsSchema,
    // Each entry is answered on its own, so an ELI no spelling rescues is that
    // entry's `not_found`, not a refusal of the whole batch.
    inputNormalization: {
      "items[].eli": {
        ...ELI_NORMALIZATION,
        invalidValueDisposition: "handler-owned",
      },
    },
    access: "read",
    permissions: openMcpRead("public legislation corpus"),
    readClass: "public",
    anonymized: { exposure: "passthrough" },
    feature: "FEATURE_PUBLIC_LAW",
    name: "read_statute_provisions",
    scope: "stella:read",
  }),
  defineValibotMcpTool({
    consumesServices: false,
    annotations: {
      title: "Read provision history",
      destructiveHint: false,
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "Read one provision's wording in each consolidation " +
      "of the work, newest validity window first, so two wordings can be " +
      "compared without downloading whole statutes. Takes the work's `eli` and " +
      "an `anchor` from read_statute's outline. A consolidation that does " +
      "not carry the anchor is left out of `items`. Pass the returned " +
      "nextCursor back as cursor for older versions. Long wording returns " +
      "nextTextCursor on its item; pass it back as text_cursor with the same " +
      "eli, anchor, and version-page cursor until it is null. " +
      "Use `url` for the stella reader when served, otherwise the publisher; `source_url` is the publisher source.",
    inputSchema: readProvisionHistoryArgsSchema,
    inputNormalization: READ_PROVISION_HISTORY_INPUT_NORMALIZATION,
    access: "read",
    permissions: openMcpRead("public legislation corpus"),
    readClass: "public",
    anonymized: { exposure: "passthrough" },
    feature: "FEATURE_PUBLIC_LAW",
    _meta: { ui: { resourceUri: STATUTE_TIMELINE_RESOURCE_URI } },
    name: "read_provision_history",
    scope: "stella:read",
  }),
] as const satisfies readonly McpToolDefinition[];

const legislationResourceName = (documentId: string): string =>
  serializeAuthorizedCorpusMcpResourceName(
    resourceRef({
      type: RESOURCE_TYPE.LEGISLATION_DOCUMENT,
      id: brandPersistedLegislationDocumentId(documentId),
    }),
  );

type StatuteResolutionRefusal = Exclude<
  StatuteExpressionResolution,
  { type: "expression" }
>;

/**
 * The versions an inconsistency names, as an agent reads them: which
 * consolidation, the window the publisher stated, and why it cannot apply.
 */
const describeInconsistentVersions = (
  versions: readonly LegislationInconsistentVersion[],
): string =>
  `Versions with inconsistent publisher dates: ${versions
    .map(
      (version) =>
        `${legislationResourceName(version.id)} (${version.language}, stated window ${version.versionValidFrom ?? "no start"} to ${version.versionValidTo ?? "no end"}, ${version.basis ?? "no basis"})`,
    )
    .join("; ")}.`;

/**
 * The one place a resolver refusal becomes an agent-facing next step. The two
 * refusals are different questions: a misspelled ELI is answered by a search,
 * a date the corpus does not cover by another date.
 */
const statuteResolutionError = (
  refusal: StatuteResolutionRefusal,
  { asOf, uncoveredHint }: { asOf: string | undefined; uncoveredHint: string },
): InternalToolErrorResult => {
  switch (refusal.type) {
    case "unknown-work":
      return notFoundResult("Legislation not found", FIND_THE_ELI_HINT);
    case "uncovered-date":
      return notFoundResult(
        asOf === undefined
          ? "No version of this legislation is in force today"
          : `No version of this legislation was in force on ${asOf}`,
        uncoveredHint,
      );
    case LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT:
      return notFoundResult(
        LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_MESSAGE,
        `${describeInconsistentVersions(refusal.versions)} ${uncoveredHint}`,
      );
    default:
      refusal satisfies never;
      return panic("Unhandled statute expression resolution");
  }
};

const invalidCursorError = (toolName: LegislationToolName, cursor: string) =>
  invalidCursorResult({ cursor, tool: toolName });

// --- search_legislation ---------------------------------------------------

const handleSearchLegislationTool: TypedMcpToolHandler<
  v.InferInput<typeof SEARCH_LEGISLATION_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(searchLegislationArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const {
    country,
    as_of: asOf,
    cursor,
    date_from: dateFrom,
    date_to: dateTo,
    document_type: documentType,
    language,
    query,
    status,
  } = parsed.output;
  const limit = normalizeTenantPageLimit(
    parsed.output.limit ?? DEFAULT_SEARCH_LIMIT,
  );

  const unavailable = publicCountryUnavailable(country, {
    domain: "legislation",
    surface: "search",
  });
  if (unavailable !== null) {
    return toolDataResult(unavailable);
  }
  const jurisdiction = publicLegislationCountry(country);
  if (jurisdiction === null) {
    return notFoundResult(
      "Legislation country not found",
      `Pass one of the admitted country codes: ${ADMITTED_COUNTRIES}.`,
    );
  }

  const observer = actionRequestObserver(
    context.organizationId,
    ACTION_COST_CALL_KIND.corpusRequest,
  );
  const result = await (
    context.testDependencies?.searchLegislationHandler ??
    defaultSearchLegislationHandler
  )(
    {
      query,
      limit,
      jurisdiction,
      ...(cursor === undefined ? {} : { cursor }),
      ...(documentType === undefined ? {} : { documentType }),
      ...(status === undefined ? {} : { status }),
      ...(language === undefined ? {} : { language }),
      ...(dateFrom === undefined ? {} : { dateFrom }),
      ...(dateTo === undefined ? {} : { dateTo }),
      ...(asOf === undefined ? {} : { asOf }),
    },
    legislationPublicReadDb,
    observer,
  );
  if (isSearchIndexUnavailable(result)) {
    return searchIndexUnavailableResult(result);
  }
  if (!isLegislationSearchSuccess(result)) {
    const failure = handlerStatusOf(result);
    return failure?.message === "Invalid cursor"
      ? invalidCursorError("search_legislation", cursor ?? "")
      : errorResult(failure?.message ?? "Legislation search failed");
  }

  return toolDataResult(
    projectionPayload(SEARCH_LEGISLATION_PROJECTION, {
      nextCursor: result.nextCursor,
      paginationOutcome: result.paginationOutcome,
      results: result.items.map((hit) => ({
        ...legalCitationLinkFields({
          url: buildLegislationDocumentAppUrl({
            country: hit.country,
            documentId: hit.documentId,
            eli: hit.eli,
            slug: hit.slug,
          }),
          sourceUrl: hit.sourceUrl,
        }),
        country: hit.country,
        documentId: hit.documentId,
        documentType: hit.documentType,
        effectiveDate: hit.effectiveDate,
        versionValidFrom: hit.versionValidFrom,
        versionValidTo: hit.versionValidTo,
        eli: hit.eli,
        language: hit.language,
        match: hit.match,
        resourceName: legislationResourceName(hit.documentId),
        score: hit.score,
        snippet: toPlainTextSnippet(hit.headline),
        sourceUrl: hit.sourceUrl,
        status: hit.status,
        title: hit.title,
      })),
      total: result.total,
    }),
  );
};

// --- read_statute ---------------------------------------------------------

type StatuteVersionsPage = Extract<
  Awaited<ReturnType<typeof listStatuteVersionsHandler>>,
  { items: unknown[] }
>;

const isStatuteVersionsPage = (
  value: Awaited<ReturnType<typeof listStatuteVersionsHandler>>,
): value is StatuteVersionsPage =>
  typeof value === "object" && "items" in value && Array.isArray(value.items);

/** The heading blocks a consolidation carries, in document order, bounded. */
const buildStatuteOutline = (blocks: readonly Block[]) => {
  const headings = blocks.flatMap((block) =>
    block.type === "heading"
      ? [
          {
            anchorId: block.anchorId,
            level: block.level,
            text: block.plainText,
          },
        ]
      : [],
  );
  const outlineTruncated =
    headings.length > LIMITS.legislationOutlineHeadingsMax;

  return {
    outline: outlineTruncated
      ? headings.slice(0, LIMITS.legislationOutlineHeadingsMax)
      : headings,
    outlineTruncated,
  };
};

type ReadStatutePageContextOptions = {
  cursor: string | undefined;
  document: StatuteDocument;
  context: McpRequestContext;
};

// Versions and navigation describe the whole consolidation; only its first
// text page reads and emits them.
const readStatutePageContext = async ({
  cursor,
  document,
  context,
}: ReadStatutePageContextOptions) => {
  if (cursor !== undefined) {
    return {};
  }
  const versionsPage = await (
    context.testDependencies?.listStatuteVersionsHandler ??
    defaultListStatuteVersionsHandler
  )({
    documentId: document.id,
    query: {
      limit: normalizeTenantPageLimit(
        LIMITS.legislationVersionsPageSizeDefault,
      ),
    },
    legislationDb: legislationPublicReadDb,
    surface: "search",
  });
  if (!isStatuteVersionsPage(versionsPage)) {
    return notFoundResult("Legislation not found", FIND_THE_ELI_HINT);
  }
  const navigation = hasUsableAst(document.documentAst)
    ? buildStatuteOutline(document.documentAst.blocks)
    : { outline: [], outlineTruncated: false };
  return {
    ...navigation,
    versions: versionsPage.items.map((version) => ({
      amendedBy: version.amendedBy ?? null,
      documentId: version.id,
      resourceName: legislationResourceName(version.id),
      versionValidFrom: version.versionValidFrom,
      versionValidTo: version.versionValidTo,
      expressionKind: version.expressionKind,
      windowDisposition: version.windowDisposition,
      windowDispositionBasis: version.windowDispositionBasis,
    })),
  };
};

const handleReadStatuteTool: TypedMcpToolHandler<
  v.InferInput<typeof READ_STATUTE_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(readStatuteArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const { as_of: asOf, cursor, eli, language } = parsed.output;

  const resolved = await (
    context.testDependencies?.resolveStatuteExpression ??
    defaultResolveStatuteExpression
  )(
    {
      eli,
      ...(language === undefined ? {} : { language }),
      ...(asOf === undefined ? {} : { asOf }),
    },
    legislationPublicReadDb,
    "search",
  );
  if (resolved.type !== "expression") {
    return statuteResolutionError(resolved, {
      asOf,
      uncoveredHint:
        "Omit as_of for the current text, or call read_provision_history to see the version windows.",
    });
  }

  const document = await (
    context.testDependencies?.readPublicLegislationHandler ??
    defaultReadPublicLegislationHandler
  )(resolved.id, legislationPublicReadDb, "search");
  if (!isStatuteDocument(document)) {
    return notFoundResult("Legislation not found", FIND_THE_ELI_HINT);
  }

  const pageContext = await readStatutePageContext({
    cursor,
    document,
    context,
  });
  if (isToolErrorResult(pageContext)) {
    return pageContext;
  }
  const ast = hasUsableAst(document.documentAst) ? document.documentAst : null;

  // Displaying the wording and feeding it to a model are separate
  // permissions: a source cleared only for display answers with everything
  // except the text.
  const plainText = document.allowsDerivedAi
    ? toPlainCorpusText({
        blocks: ast?.blocks ?? null,
        fulltext: document.fulltext,
      })
    : null;
  const window =
    plainText === null
      ? null
      : windowTextByCursor({
          cursor,
          maxChars: MCP_CONTENT_MAX_CHARS,
          text: plainText,
        });
  if (isToolErrorResult(window)) {
    return window;
  }

  return toolDataResult(
    projectionPayload(READ_STATUTE_PROJECTION, {
      nextCursor: window?.nextCursor ?? null,
      statute: {
        ...legalCitationLinkFields({
          url: buildLegislationDocumentAppUrl({
            country: document.country,
            documentId: document.id,
            eli: document.eli,
            slug: document.slug,
            version: asOf === undefined ? null : document.versionValidFrom,
          }),
          sourceUrl: document.sourceUrl,
        }),
        charCount: window?.charCount ?? null,
        country: document.country,
        documentId: document.id,
        documentType: document.documentType,
        effectiveDate: document.effectiveDate,
        eli: document.eli,
        language: document.language,
        ...pageContext,
        resourceName: legislationResourceName(document.id),
        sourceUrl: document.sourceUrl,
        status: document.status,
        text: window?.text ?? null,
        title: document.title,
        truncated: window?.truncated ?? false,
        versionValidFrom: document.versionValidFrom,
        versionValidTo: document.versionValidTo,
        expressionKind: document.expressionKind,
        windowDisposition: document.windowDisposition,
        windowDispositionBasis: document.windowDispositionBasis,
        pendingChanges: document.pendingChanges,
        ...(document.allowsDerivedAi
          ? {}
          : {
              textWithheldReason:
                "The source licence does not permit AI use of the full text.",
            }),
      },
    }),
  );
};

// --- read_statute_provisions ----------------------------------------------

type ProvisionRequest = v.InferOutput<typeof provisionRequestSchema>;

type ProvisionItemResult = v.InferInput<
  typeof READ_STATUTE_PROVISIONS_PROJECTION
>["items"][number];

/** One exact or date-based address, spelled once so it resolves once. */
const provisionRequestKey = (item: ProvisionRequest): string =>
  JSON.stringify([
    item.eli,
    item.language ?? null,
    item.as_of ?? null,
    item.document_id ?? null,
  ]);

type ProvisionItemBuildResult =
  { type: "item"; item: ProvisionItemResult } | { type: "invalid-cursor" };

/**
 * The provision's printed citation (`§ 1729 89/2012 Sb.`), beside its reader
 * link: a source list names the link by it rather than by the link's host.
 * Absent where the act has no number or its jurisdiction no citation profile.
 */
const provisionCitationField = ({
  anchor,
  country,
  eli,
}: {
  anchor: string;
  country: string;
  eli: string;
}): { citation?: string } => {
  const work = statuteActNumber(eli);
  const citation =
    work === null
      ? null
      : anchorProvisionCitation({
          anchor,
          jurisdiction: country,
          workIdentifier: work,
        });
  return citation === null ? {} : { citation };
};

const provisionItemResult = ({
  blocksByDocumentId,
  item,
  resolution,
  versionsByDocumentId,
}: {
  blocksByDocumentId: ReadonlyMap<string, readonly Block[]>;
  item: ProvisionRequest;
  resolution: StatuteExpressionResolution;
  versionsByDocumentId: ReadonlyMap<string, LegislationProvisionVersion>;
}): ProvisionItemBuildResult => {
  const subject = { anchor: item.anchor, eli: item.eli };
  const unknownWork = {
    ...subject,
    message: `No legislation with this ELI is in the corpus. ${FIND_THE_ELI_HINT}`,
    status: PROVISION_STATUS.notFound,
  } as const;

  switch (resolution.type) {
    case "unknown-work":
      return { type: "item", item: unknownWork };
    case "uncovered-date":
      return {
        type: "item",
        item: {
          ...subject,
          message:
            item.as_of === undefined
              ? "No version of this legislation is in force today."
              : `No version of this legislation was in force on ${item.as_of}.`,
          status: PROVISION_STATUS.uncoveredDate,
        },
      };
    // The same next step as an uncovered date (another date, or the
    // history), so the same status; the message says why.
    case LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT:
      return {
        type: "item",
        item: {
          ...subject,
          message: `${LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_MESSAGE}. ${describeInconsistentVersions(resolution.versions)}`,
          status: PROVISION_STATUS.uncoveredDate,
        },
      };
    case "expression": {
      // Absent where the source was withdrawn between the resolution and
      // this read, which is the same answer as no such work.
      const version = versionsByDocumentId.get(String(resolution.id));
      if (version === undefined || version.eli !== item.eli) {
        return {
          type: "item",
          item:
            item.document_id === undefined
              ? unknownWork
              : {
                  ...subject,
                  message:
                    "This document_id does not belong to the requested eli.",
                  status: PROVISION_STATUS.notFound,
                },
        };
      }
      const links = legalCitationLinkFields({
        url: buildLegislationDocumentAppUrl({
          country: version.country,
          documentId: version.id,
          eli: item.eli,
          slug: version.slug,
          version: version.versionValidFrom,
          anchor: item.anchor,
        }),
        sourceUrl: version.sourceUrl,
      });
      const cited = {
        ...links,
        ...provisionCitationField({
          anchor: item.anchor,
          country: version.country,
          eli: item.eli,
        }),
      };
      if (!version.allowsDerivedAi) {
        return {
          type: "item",
          item: {
            ...subject,
            ...cited,
            message: WITHHELD_WORDING_MESSAGE,
            status: PROVISION_STATUS.textWithheld,
          },
        };
      }

      // Every readable consolidation was read above; a miss is a programming
      // error, never an empty statute.
      const blocks =
        blocksByDocumentId.get(String(version.id)) ??
        panic(`No block list was read for consolidation ${version.id}`);
      const text = extractProvisionText(blocks, item.anchor);
      if (text === null) {
        return {
          type: "item",
          item: {
            ...subject,
            message: `This consolidation carries no such anchor. ${PICK_AN_ANCHOR_HINT}`,
            status: PROVISION_STATUS.provisionNotFound,
          },
        };
      }

      const window = windowProvisionText({
        ...(item.text_cursor === undefined ? {} : { cursor: item.text_cursor }),
        limit: LIMITS.legislationProvisionTextChars,
        subject: JSON.stringify([item.eli, item.anchor, String(version.id)]),
        text,
      });
      if (window.type === "invalid-cursor") {
        return { type: "invalid-cursor" };
      }
      return {
        type: "item",
        item: {
          ...subject,
          ...cited,
          text: window.text,
          truncated: window.truncated,
          nextTextCursor: window.nextTextCursor,
          documentId: version.id,
          resourceName: legislationResourceName(version.id),
          status: PROVISION_STATUS.found,
          versionValidFrom: version.versionValidFrom,
          versionValidTo: version.versionValidTo,
        },
      };
    }
    default:
      resolution satisfies never;
      return panic("Unhandled statute expression resolution");
  }
};

/** One requested entry: either it parsed, or it is answered on its own. */
type ParsedProvisionEntry =
  | { type: "entry"; request: ProvisionRequest }
  | { type: "invalid"; result: ProvisionItemResult };

/**
 * Read each entry through the element schema the tool advertises. A refused
 * entry becomes its own `invalid` answer instead of failing the call, which
 * is what makes the batch worth batching: a model resends one entry, not
 * nineteen good ones.
 */
const parseProvisionEntries = (
  items: readonly unknown[],
): readonly ParsedProvisionEntry[] =>
  items.map((item, index) => {
    const entry = v.safeParse(provisionEntrySchema, item);
    if (entry.success) {
      if (
        entry.output.as_of !== undefined &&
        entry.output.document_id !== undefined
      ) {
        return {
          type: "invalid",
          result: {
            index,
            issues: [
              {
                message: "Pass document_id or as_of, not both",
                path: "items[].document_id",
              },
            ],
            message: "Pass document_id or as_of, not both",
            status: PROVISION_STATUS.invalid,
          },
        };
      }
      return { type: "entry", request: entry.output };
    }
    const issues = mapValibotIssues(entry.issues);
    return {
      type: "invalid",
      result: {
        index,
        issues,
        message:
          issues.at(0)?.message ?? "This entry does not match items[]'s shape",
        status: PROVISION_STATUS.invalid,
      },
    };
  });

const handleReadStatuteProvisionsTool: TypedMcpToolHandler<
  v.InferInput<typeof READ_STATUTE_PROVISIONS_PROJECTION>
> = async ({ args, context }) => {
  // Two stages: the envelope and the array bound fail the whole call, because
  // a call with no items or twenty-one of them asked for nothing answerable.
  const parsed = v.safeParse(provisionsBatchEnvelopeSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const entries = parseProvisionEntries(parsed.output.items);

  // Two de-duplication passes, so a batch naming the same act twenty times
  // resolves it once and reads its AST once.
  const requestsByKey = new Map<string, ProvisionRequest>();
  for (const entry of entries) {
    if (entry.type !== "entry") {
      continue;
    }
    const key = provisionRequestKey(entry.request);
    if (!requestsByKey.has(key)) {
      requestsByKey.set(key, entry.request);
    }
  }

  const keys = [...requestsByKey.keys()];
  const resolve =
    context.testDependencies?.resolveStatuteExpression ??
    defaultResolveStatuteExpression;
  const resolutions = await mapWithConcurrency({
    items: keys,
    limit: LIMITS.legislationProvisionReadConcurrency,
    operation: async (key) => {
      const request =
        requestsByKey.get(key) ?? panic("Lost a provision request key");
      if (request.document_id !== undefined) {
        return {
          type: "expression",
          id: brandPersistedLegislationDocumentId(request.document_id),
        } as const;
      }
      return await resolve(
        {
          eli: request.eli,
          ...(request.language === undefined
            ? {}
            : { language: request.language }),
          ...(request.as_of === undefined ? {} : { asOf: request.as_of }),
        },
        legislationPublicReadDb,
        "search",
      );
    },
  });
  const resolutionsByKey = new Map(
    keys.map((key, index) => [
      key,
      resolutions[index] ?? panic("Lost a provision resolution"),
    ]),
  );

  const documentIds = [
    ...new Set(
      [...resolutionsByKey.values()].flatMap((resolution) =>
        resolution.type === "expression" ? [resolution.id] : [],
      ),
    ),
  ];
  const versions =
    documentIds.length === 0
      ? []
      : await (
          context.testDependencies?.readLegislationProvisionVersions ??
          defaultReadLegislationProvisionVersions
        )({
          documentIds,
          legislationDb: legislationPublicReadDb,
          surface: "search",
        });
  const versionsByDocumentId = new Map(
    versions.map((version) => [String(version.id), version]),
  );

  // Each AST is an object-storage hop, so the fan-out is bounded rather than
  // one read per requested item.
  const requestedElisByDocumentId = new Map<string, Set<string>>();
  for (const [key, resolution] of resolutionsByKey) {
    if (resolution.type !== "expression") {
      continue;
    }
    const request = requestsByKey.get(key) ?? panic("Lost a provision request");
    const id = String(resolution.id);
    const requestedElis = requestedElisByDocumentId.get(id) ?? new Set();
    requestedElis.add(request.eli);
    requestedElisByDocumentId.set(id, requestedElis);
  }
  const readable = versions.filter(
    (version) =>
      version.allowsDerivedAi &&
      requestedElisByDocumentId.get(String(version.id))?.has(version.eli) ===
        true,
  );
  const readBlocks =
    context.testDependencies?.readVersionBlocks ?? readVersionBlocks;
  const blocksByDocumentId = new Map(
    await mapWithConcurrency({
      items: readable,
      limit: LIMITS.legislationProvisionReadConcurrency,
      operation: async (version) =>
        [
          String(version.id),
          await readBlocks({
            surface: "search",
            row: version,
            legislationDb: legislationPublicReadDb,
            step: PROVISION_READ_STEP,
            purpose: "derived-ai",
          }),
        ] as const,
    }),
  );

  const built = entries.map((entry) =>
    entry.type === "invalid"
      ? ({ type: "item", item: entry.result } as const)
      : provisionItemResult({
          blocksByDocumentId,
          item: entry.request,
          resolution:
            resolutionsByKey.get(provisionRequestKey(entry.request)) ??
            panic("Lost a provision resolution"),
          versionsByDocumentId,
        }),
  );
  return toolDataResult(
    projectionPayload(READ_STATUTE_PROVISIONS_PROJECTION, {
      items: built.map((result, index) => {
        switch (result.type) {
          case "item":
            return result.item;
          case "invalid-cursor": {
            const message =
              "Invalid text_cursor. Retry this entry without text_cursor to read its current wording.";
            return {
              index,
              issues: [{ message, path: "items[].text_cursor" }],
              message,
              status: PROVISION_STATUS.invalid,
            } satisfies ProvisionItemResult;
          }
          default:
            result satisfies never;
            return panic("Unhandled provision item result");
        }
      }),
    }),
  );
};

// --- read_provision_history -----------------------------------------------

type ProvisionHistoryPage = Extract<
  Awaited<ReturnType<typeof readProvisionHistoryHandler>>,
  { items: unknown[] }
>;

const isProvisionHistoryPage = (
  value: Awaited<ReturnType<typeof readProvisionHistoryHandler>>,
): value is ProvisionHistoryPage =>
  typeof value === "object" && "items" in value && Array.isArray(value.items);

const handleReadProvisionHistoryTool: TypedMcpToolHandler<
  v.InferInput<typeof READ_PROVISION_HISTORY_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(readProvisionHistoryArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const {
    anchor,
    cursor,
    eli,
    language,
    text_cursor: textCursor,
  } = parsed.output;
  const limit = normalizeTenantPageLimit(
    parsed.output.limit ?? LIMITS.legislationProvisionHistoryPageSizeDefault,
  );

  // The history walks the whole Work, so it resolves the Work rather than a
  // consolidation applicable today: a repealed, expired or not-yet-effective
  // act has no applicable expression and every one of its consolidations is
  // still readable history.
  const resolved = await (
    context.testDependencies?.resolveStatuteWorkVersion ??
    defaultResolveStatuteWorkVersion
  )(
    { eli, ...(language === undefined ? {} : { language }) },
    legislationPublicReadDb,
    "search",
  );
  if (resolved.type !== "expression") {
    return statuteResolutionError(resolved, {
      asOf: undefined,
      uncoveredHint:
        "Read a dated consolidation with read_statute (as_of) and work from the eli it returns.",
    });
  }

  const page = await (
    context.testDependencies?.readProvisionHistoryHandler ??
    defaultReadProvisionHistoryHandler
  )({
    documentId: resolved.id,
    anchor,
    query: { limit, ...(cursor === undefined ? {} : { cursor }) },
    legislationDb: legislationPublicReadDb,
    surface: "search",
  });
  if (!isProvisionHistoryPage(page)) {
    const failure = handlerStatusOf(page);
    if (failure?.message === "Invalid cursor") {
      return invalidCursorError("read_provision_history", cursor ?? "");
    }
    return failure?.message === "Provision not found"
      ? notFoundResult("Provision not found", PICK_AN_ANCHOR_HINT)
      : notFoundResult("Legislation not found", FIND_THE_ELI_HINT);
  }

  const items = page.items.map((item) => {
    const version = {
      ...legalCitationLinkFields({
        url: buildLegislationDocumentAppUrl({
          country: item.country,
          documentId: item.documentId,
          eli,
          slug: item.slug,
          version: item.versionValidFrom,
          anchor,
        }),
        sourceUrl: item.sourceUrl,
      }),
      ...provisionCitationField({ anchor, country: item.country, eli }),
      documentId: item.documentId,
      resourceName: legislationResourceName(item.documentId),
      versionValidFrom: item.versionValidFrom,
      versionValidTo: item.versionValidTo,
      expressionKind: item.expressionKind,
      windowDisposition: item.windowDisposition,
      windowDispositionBasis: item.windowDispositionBasis,
    };
    if (!item.allowsDerivedAi) {
      return {
        type: "item" as const,
        item: {
          ...version,
          message: WITHHELD_WORDING_MESSAGE,
          status: PROVISION_STATUS.textWithheld,
        },
      };
    }
    const window = windowProvisionText({
      ...(textCursor === undefined ? {} : { cursor: textCursor }),
      limit: LIMITS.legislationProvisionTextChars,
      subject: JSON.stringify([eli, anchor, String(item.documentId)]),
      text: item.text,
    });
    return window.type === "invalid-cursor"
      ? { type: "invalid-cursor" as const }
      : {
          type: "item" as const,
          item: {
            ...version,
            text: window.text,
            truncated: window.truncated,
            nextTextCursor: window.nextTextCursor,
            status: PROVISION_STATUS.found,
          },
        };
  });
  const readableItems = items.filter(
    (item) => item.type === "item" && "text" in item.item,
  );
  if (textCursor !== undefined && readableItems.length === 0) {
    return invalidCursorError("read_provision_history", textCursor);
  }

  return toolDataResult(
    projectionPayload(READ_PROVISION_HISTORY_PROJECTION, {
      anchor,
      eli,
      items: (textCursor === undefined ? items : readableItems).map((item) =>
        item.type === "item"
          ? item.item
          : panic("Invalid text cursor was not returned"),
      ),
      nextCursor: page.nextCursor,
    }),
  );
};

export const LEGISLATION_TOOL_HANDLERS = {
  search_legislation: handleSearchLegislationTool,
  read_statute: handleReadStatuteTool,
  read_statute_provisions: handleReadStatuteProvisionsTool,
  read_provision_history: handleReadProvisionHistoryTool,
} satisfies Record<LegislationToolName, McpToolHandler>;

export const LEGISLATION_TOOL_SET = defineMcpToolSet(
  LEGISLATION_TOOL_DEFINITIONS,
  LEGISLATION_TOOL_HANDLERS,
  {
    search_legislation: defineChatProjectionMcpToolOutput(
      SEARCH_LEGISLATION_PROJECTION,
    ),
    read_statute: defineChatProjectionMcpToolOutput(READ_STATUTE_PROJECTION),
    read_statute_provisions: defineChatProjectionMcpToolOutput(
      READ_STATUTE_PROVISIONS_PROJECTION,
    ),
    read_provision_history: defineChatProjectionMcpToolOutput(
      READ_PROVISION_HISTORY_PROJECTION,
    ),
  },
);
