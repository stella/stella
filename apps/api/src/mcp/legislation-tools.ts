import { panic } from "better-result";
import * as v from "valibot";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";
import {
  PUBLIC_LEGISLATION_COUNTRIES,
  publicLegislationCountry,
} from "@stll/api-contract/legislation-publication";
import { mapWithConcurrency } from "@stll/concurrency";
import type { Block } from "@stll/legal-ast/document-ast";
import { hasUsableAst } from "@stll/legal-ast/document-ast";

import type { StatuteExpressionResolution } from "@/api/handlers/legislation/by-eli";
import type { readProvisionHistoryHandler } from "@/api/handlers/legislation/provision-history";
import { extractProvisionText } from "@/api/handlers/legislation/provision-text";
import type { LegislationProvisionVersion } from "@/api/handlers/legislation/provision-versions";
import type { listStatuteVersionsHandler } from "@/api/handlers/legislation/versions";
import {
  READ_PROVISION_HISTORY_PROJECTION,
  READ_STATUTE_PROJECTION,
  READ_STATUTE_PROVISIONS_PROJECTION,
  SEARCH_LEGISLATION_PROJECTION,
} from "@/api/lib/chat/projections";
import { PROVISION_STATUS } from "@/api/lib/legal-search/legislation-provision-vocabulary";
import { readVersionBlocks } from "@/api/lib/legal-search/legislation-version-blocks";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedLegislationDocumentId } from "@/api/lib/safe-id-boundaries";
import {
  isLegislationSearchSuccess,
  isStatuteDocument,
  defaultListStatuteVersionsHandler,
  defaultReadLegislationProvisionVersions,
  defaultReadProvisionHistoryHandler,
  defaultReadPublicLegislationHandler,
  defaultResolveStatuteExpression,
  defaultResolveStatuteWorkVersion,
  defaultSearchLegislationHandler,
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
  countryInputSchema,
  countryNormalization,
  cursorInput,
  DEFAULT_SEARCH_LIMIT,
  errorResult,
  handlerStatusOf,
  ISO_DATE_SCHEMA,
  isToolErrorResult,
  MCP_CONTENT_MAX_CHARS,
  mapValibotIssues,
  notFoundResult,
  nullAsAbsent,
  structuredErrorResult,
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
  "The source licence does not permit AI use of this wording. Read it at the statute's appUrl instead.";

const eliInputSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(512),
  v.description(
    "European Legislation Identifier of the work, exactly as " +
      "search_legislation returns it (for example /eli/cz/sb/2012/89). It " +
      "addresses the act, not one consolidation of it.",
  ),
);

const anchorInputSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(256),
  v.description(
    "Anchor of the provision in the publisher's own scheme. read_statute's " +
      "outline lists a consolidation's provision anchors (par_1729); a " +
      "subdivision of one of them is accepted too and narrows the answer to " +
      "that subdivision (par_1729-odst_1, par_1729-odst_2-pism_a). Anchors " +
      "are not derivable from a section number.",
  ),
);

const asOfInputSchema = v.pipe(
  ISO_DATE_SCHEMA,
  v.maxLength(10),
  v.description(
    "Read the consolidation in force on this ISO date (YYYY-MM-DD); omit it " +
      "for the text in force today.",
  ),
);

const languageInputSchema = v.pipe(
  v.string(),
  v.minLength(2),
  v.maxLength(8),
  v.description(
    "Language of the consolidation to read. Language is part of the work " +
      "key, so an act published in two languages has one consolidation in " +
      "each.",
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
        ISO_DATE_SCHEMA,
        v.maxLength(10),
        v.description(
          "Filter statutes effective from this ISO date (YYYY-MM-DD)",
        ),
      ),
    ),
    date_to: v.optional(
      v.pipe(
        ISO_DATE_SCHEMA,
        v.maxLength(10),
        v.description(
          "Filter statutes effective up to this ISO date (YYYY-MM-DD)",
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
  language: v.optional(languageInputSchema),
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

const readProvisionHistoryArgsSchema = nullAsAbsent(
  v.strictObject({
    eli: eliInputSchema,
    anchor: anchorInputSchema,
    language: v.optional(languageInputSchema),
    limit: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(LIMITS.legislationProvisionHistoryPageSizeMax),
        v.description(
          `Versions per page; defaults to ${LIMITS.legislationProvisionHistoryPageSizeDefault}, at most ${LIMITS.legislationProvisionHistoryPageSizeMax}.`,
        ),
      ),
    ),
    cursor: cursorInput({
      description:
        "Opaque cursor from a previous read_provision_history call to read the next page",
    }),
  }),
);

const LEGISLATION_TOOL_DEFINITIONS = [
  defineValibotMcpTool({
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
      "YYYY-MM-DD). No facets are returned and `total` is not counted, so " +
      "page with the returned nextCursor instead of reasoning about a result " +
      "count. A hit is metadata only: pass its `eli` to read_statute for the " +
      "text, the outline of anchors and the consolidated versions.",
    inputSchema: searchLegislationArgsSchema,
    inputNormalization: {
      country: countryNormalization({
        spelling: "alpha-3",
        admitted: PUBLIC_LEGISLATION_COUNTRIES,
        tool: SEARCH_LEGISLATION_TOOL,
      }),
    },
    access: "read",
    anonymized: { exposure: "passthrough" },
    // Backed by the public legislation corpus (legislationPublicReadDb), the
    // same surface the public routes gate behind the same feature flag.
    feature: "FEATURE_PUBLIC_LAW",
    name: SEARCH_LEGISLATION_TOOL,
    scope: "stella:search",
  }),
  defineValibotMcpTool({
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
      "window, `versions` (the newest page of the work's consolidations), " +
      "`outline` (its heading anchors, the input read_statute_provisions " +
      "takes) and its plain text. Long text comes back in windows; pass the " +
      "returned nextCursor back as cursor to read more. A source that bars " +
      "AI use of its wording still answers with metadata, versions and " +
      "outline, and `textWithheldReason` in place of the text.",
    inputSchema: readStatuteArgsSchema,
    access: "read",
    anonymized: { exposure: "passthrough" },
    feature: "FEATURE_PUBLIC_LAW",
    name: "read_statute",
    scope: "stella:read",
  }),
  defineValibotMcpTool({
    annotations: {
      title: "Read statute provisions",
      destructiveHint: false,
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "Read named provisions of one or more statutes in one call: each " +
      "`items[]` entry is { eli, anchor } plus an optional as_of and " +
      "language. An anchor is the publisher's own (par_1729, " +
      "par_1729-odst_1) and read_statute's `outline` lists them. Every entry " +
      "is answered separately, in input order, under `status`: `found` " +
      "carries the provision's text, while `not_found` (no such ELI), " +
      "`uncovered_date` (no consolidation covers that day), " +
      "`provision_not_found` (that consolidation has no such anchor) and " +
      "`text_withheld` (the source bars AI use of its wording) each carry a " +
      "message. Prefer one batched call over one call per provision.",
    inputSchema: readStatuteProvisionsArgsSchema,
    access: "read",
    anonymized: { exposure: "passthrough" },
    feature: "FEATURE_PUBLIC_LAW",
    name: "read_statute_provisions",
    scope: "stella:read",
  }),
  defineValibotMcpTool({
    annotations: {
      title: "Read provision history",
      destructiveHint: false,
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "How one provision's wording changed: its text in each consolidation " +
      "of the work, newest validity window first, so two wordings can be " +
      "compared without downloading whole statutes. Takes the work's `eli` and " +
      "an `anchor` from read_statute's outline. A consolidation that does " +
      "not carry the anchor is left out of `items`. Pass the returned " +
      "nextCursor back as cursor for older windows.",
    inputSchema: readProvisionHistoryArgsSchema,
    access: "read",
    anonymized: { exposure: "passthrough" },
    feature: "FEATURE_PUBLIC_LAW",
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
    default:
      refusal satisfies never;
      return panic("Unhandled statute expression resolution");
  }
};

const invalidCursorError = (toolName: LegislationToolName) =>
  structuredErrorResult({
    code: "validation_error",
    message: "Invalid cursor",
    issues: [{ path: "cursor", message: "Invalid cursor" }],
    hint: `Pass the 'cursor' verbatim as returned by a previous ${toolName} call, or omit it for the first page.`,
  });

/** Text cut to the provision budget, and whether the budget cut it. */
const boundProvisionText = (text: string) => {
  const bounded = text.slice(0, LIMITS.legislationProvisionTextChars);
  return { text: bounded, truncated: bounded.length < text.length };
};

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
    cursor,
    date_from: dateFrom,
    date_to: dateTo,
    document_type: documentType,
    language,
    query,
    status,
  } = parsed.output;
  const limit = parsed.output.limit ?? DEFAULT_SEARCH_LIMIT;

  const jurisdiction = publicLegislationCountry(country);
  if (jurisdiction === null) {
    return notFoundResult(
      "Legislation country not found",
      `Pass one of the admitted country codes: ${ADMITTED_COUNTRIES}.`,
    );
  }

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
    },
    legislationPublicReadDb,
  );
  if (!isLegislationSearchSuccess(result)) {
    const failure = handlerStatusOf(result);
    return failure?.message === "Invalid cursor"
      ? invalidCursorError("search_legislation")
      : errorResult(failure?.message ?? "Legislation search failed");
  }

  return toolDataResult({
    nextCursor: result.nextCursor,
    results: result.items.map((hit) => ({
      appUrl: buildLegislationDocumentAppUrl({
        country: hit.country,
        documentId: hit.documentId,
        eli: hit.eli,
        slug: hit.slug,
      }),
      country: hit.country,
      documentId: hit.documentId,
      documentType: hit.documentType,
      effectiveDate: hit.effectiveDate,
      eli: hit.eli,
      language: hit.language,
      resourceName: legislationResourceName(hit.documentId),
      score: hit.score,
      snippet: toPlainTextSnippet(hit.headline),
      sourceUrl: hit.sourceUrl,
      status: hit.status,
      title: hit.title,
    })),
    total: result.total,
  } satisfies v.InferInput<typeof SEARCH_LEGISLATION_PROJECTION>);
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
  )(resolved.id, legislationPublicReadDb);
  if (!isStatuteDocument(document)) {
    return notFoundResult("Legislation not found", FIND_THE_ELI_HINT);
  }

  // What makes the version endpoint covered: the read that answers for one
  // consolidation also says which other consolidations of the work exist.
  const versionsPage = await (
    context.testDependencies?.listStatuteVersionsHandler ??
    defaultListStatuteVersionsHandler
  )({
    documentId: resolved.id,
    query: { limit: LIMITS.legislationVersionsPageSizeDefault },
    legislationDb: legislationPublicReadDb,
  });
  if (!isStatuteVersionsPage(versionsPage)) {
    return notFoundResult("Legislation not found", FIND_THE_ELI_HINT);
  }

  const { outline, outlineTruncated } = hasUsableAst(document.documentAst)
    ? buildStatuteOutline(document.documentAst.blocks)
    : { outline: [], outlineTruncated: false };
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
  if (window !== null && isToolErrorResult(window)) {
    return window;
  }

  return toolDataResult({
    nextCursor: window?.nextCursor ?? null,
    statute: {
      appUrl: buildLegislationDocumentAppUrl({
        country: document.country,
        documentId: document.id,
        eli: document.eli,
        slug: document.slug,
      }),
      charCount: window?.charCount ?? null,
      country: document.country,
      documentId: document.id,
      documentType: document.documentType,
      effectiveDate: document.effectiveDate,
      eli: document.eli,
      language: document.language,
      outline,
      outlineTruncated,
      resourceName: legislationResourceName(document.id),
      sourceUrl: document.sourceUrl,
      status: document.status,
      text: window?.text ?? null,
      title: document.title,
      truncated: window?.truncated ?? false,
      versionValidFrom: document.versionValidFrom,
      versionValidTo: document.versionValidTo,
      versions: versionsPage.items.map((version) => ({
        documentId: version.id,
        resourceName: legislationResourceName(version.id),
        versionValidFrom: version.versionValidFrom,
        versionValidTo: version.versionValidTo,
      })),
      ...(document.allowsDerivedAi
        ? {}
        : {
            textWithheldReason:
              "The source licence does not permit AI use of the full text.",
          }),
    },
  } satisfies v.InferInput<typeof READ_STATUTE_PROJECTION>);
};

// --- read_statute_provisions ----------------------------------------------

type ProvisionRequest = v.InferOutput<typeof provisionRequestSchema>;

type ProvisionItemResult = v.InferInput<
  typeof READ_STATUTE_PROVISIONS_PROJECTION
>["items"][number];

/** One (eli, language, as_of) address, spelled once so it resolves once. */
const provisionRequestKey = (item: ProvisionRequest): string =>
  JSON.stringify([item.eli, item.language ?? null, item.as_of ?? null]);

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
}): ProvisionItemResult => {
  const subject = { anchor: item.anchor, eli: item.eli };
  const unknownWork = {
    ...subject,
    message: `No legislation with this ELI is in the corpus. ${FIND_THE_ELI_HINT}`,
    status: PROVISION_STATUS.notFound,
  } as const;

  switch (resolution.type) {
    case "unknown-work":
      return unknownWork;
    case "uncovered-date":
      return {
        ...subject,
        message:
          item.as_of === undefined
            ? "No version of this legislation is in force today."
            : `No version of this legislation was in force on ${item.as_of}.`,
        status: PROVISION_STATUS.uncoveredDate,
      };
    case "expression": {
      // Absent where the source was withdrawn between the resolution and
      // this read, which is the same answer as no such work.
      const version = versionsByDocumentId.get(String(resolution.id));
      if (version === undefined) {
        return unknownWork;
      }
      if (!version.allowsDerivedAi) {
        return {
          ...subject,
          message: WITHHELD_WORDING_MESSAGE,
          status: PROVISION_STATUS.textWithheld,
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
          ...subject,
          message: `This consolidation carries no such anchor. ${PICK_AN_ANCHOR_HINT}`,
          status: PROVISION_STATUS.provisionNotFound,
        };
      }

      return {
        ...subject,
        ...boundProvisionText(text),
        documentId: version.id,
        resourceName: legislationResourceName(version.id),
        status: PROVISION_STATUS.found,
        versionValidFrom: version.versionValidFrom,
        versionValidTo: version.versionValidTo,
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
      return await resolve(
        {
          eli: request.eli,
          ...(request.language === undefined
            ? {}
            : { language: request.language }),
          ...(request.as_of === undefined ? {} : { asOf: request.as_of }),
        },
        legislationPublicReadDb,
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
  const versions = await (
    context.testDependencies?.readLegislationProvisionVersions ??
    defaultReadLegislationProvisionVersions
  )({ documentIds, legislationDb: legislationPublicReadDb });
  const versionsByDocumentId = new Map(
    versions.map((version) => [String(version.id), version]),
  );

  // Each AST is an object-storage hop, so the fan-out is bounded rather than
  // one read per requested item.
  const readable = versions.filter((version) => version.allowsDerivedAi);
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
            row: version,
            legislationDb: legislationPublicReadDb,
            step: PROVISION_READ_STEP,
            purpose: "derived-ai",
          }),
        ] as const,
    }),
  );

  return toolDataResult({
    items: entries.map((entry) =>
      entry.type === "invalid"
        ? entry.result
        : provisionItemResult({
            blocksByDocumentId,
            item: entry.request,
            resolution:
              resolutionsByKey.get(provisionRequestKey(entry.request)) ??
              panic("Lost a provision resolution"),
            versionsByDocumentId,
          }),
    ),
  } satisfies v.InferInput<typeof READ_STATUTE_PROVISIONS_PROJECTION>);
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
  const { anchor, cursor, eli, language } = parsed.output;
  const limit =
    parsed.output.limit ?? LIMITS.legislationProvisionHistoryPageSizeDefault;

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
  });
  if (!isProvisionHistoryPage(page)) {
    const failure = handlerStatusOf(page);
    if (failure?.message === "Invalid cursor") {
      return invalidCursorError("read_provision_history");
    }
    return failure?.message === "Provision not found"
      ? notFoundResult("Provision not found", PICK_AN_ANCHOR_HINT)
      : notFoundResult("Legislation not found", FIND_THE_ELI_HINT);
  }

  return toolDataResult({
    anchor,
    eli,
    items: page.items.map((item) => {
      const version = {
        documentId: item.documentId,
        resourceName: legislationResourceName(item.documentId),
        versionValidFrom: item.versionValidFrom,
        versionValidTo: item.versionValidTo,
      };
      // The same publisher permission read_statute and
      // read_statute_provisions apply, per consolidation: a Work may be
      // re-licensed between versions, so the gate is per item and not per
      // call.
      return item.allowsDerivedAi
        ? {
            ...version,
            ...boundProvisionText(item.text),
            status: PROVISION_STATUS.found,
          }
        : {
            ...version,
            message: WITHHELD_WORDING_MESSAGE,
            status: PROVISION_STATUS.textWithheld,
          };
    }),
    nextCursor: page.nextCursor,
  } satisfies v.InferInput<typeof READ_PROVISION_HISTORY_PROJECTION>);
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
