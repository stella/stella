import * as v from "valibot";

import { LIMITS } from "@/api/lib/limits";
import {
  COMPAT_SEARCH_OUTPUT_SCHEMA,
  LAW_COMPAT_FETCH_OUTPUT_SCHEMA,
} from "@/api/mcp/compat-contract";
import {
  hasMoreCorpusPages,
  resolveCompatCorpusCountries,
  searchCompatCorpus,
} from "@/api/mcp/compat-corpus";
import {
  COMPAT_CORPUS_ID_HINT,
  COMPAT_CORPUS_ID_VOCABULARY,
  compatCorpusIdInputSchema,
  decodeCompatCorpusId,
} from "@/api/mcp/compat-ids";
import {
  compatCorpusFetchResponse,
  compatSearchCursorError,
  decodeCompatSearchCursor,
  encodeCompatSearchCursor,
  invalidCompatIdResult,
} from "@/api/mcp/compat-shared";
import type { McpToolDefinition, McpToolHandler } from "@/api/mcp/tool-types";
import { defineMcpToolSet } from "@/api/mcp/tool-types";
import {
  cursorInput,
  errorResult,
  nullAsAbsent,
  validationErrorResult,
} from "@/api/mcp/tool-utils";
import {
  defineMcpToolOutput,
  defineValibotMcpTool,
} from "@/api/mcp/valibot-tool-definition";

/**
 * The OpenAI-compatible `search`/`fetch` pair for the law audience.
 *
 * Same wire names as the default audience's pair, separate definitions and
 * separate handlers. A handler receives only `{ args, context }` and never the
 * request mode, so "corpus only" cannot be a branch inside the default
 * handler: it has to be a different function, and this is it. Nothing here
 * reads `context.accessibleWorkspaceIds`, the knowledge search provider, or
 * `extractedContent`, which is what makes the audience's claim that no matter
 * data is reachable a property of the code rather than of a conditional.
 */

type LawCompatToolName = "fetch" | "search";

const lawCompatSearchArgsSchema = nullAsAbsent(
  v.strictObject({
    query: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(LIMITS.searchQueryMaxLength),
      v.description("Search query"),
    ),
    cursor: cursorInput({
      description:
        "Opaque cursor from a previous search call to fetch the next page",
    }),
  }),
);

const lawCompatFetchArgsSchema = nullAsAbsent(
  v.strictObject({
    id: compatCorpusIdInputSchema(
      `Result id from search. ${COMPAT_CORPUS_ID_VOCABULARY}`,
    ),
    cursor: cursorInput({
      description:
        "Opaque cursor from a previous fetch call to read the next window of text",
    }),
  }),
);

const LAW_COMPAT_TOOL_DEFINITIONS = [
  defineValibotMcpTool({
    annotations: {
      title: "Search",
      destructiveHint: false,
      readOnlyHint: true,
      openWorldHint: false,
    },
    access: "read",
    anonymized: { exposure: "passthrough" },
    description:
      "Search the public legal corpus (case-law decisions and statutes) using " +
      "the OpenAI-compatible search tool shape, over the jurisdictions the organization " +
      `practises in. ${COMPAT_CORPUS_ID_VOCABULARY} Pass an id back to fetch verbatim. No ` +
      "matter, document, contact or billing data is reachable here.",
    feature: "FEATURE_PUBLIC_LAW",
    inputSchema: lawCompatSearchArgsSchema,
    name: "search",
    scope: "stella:search",
  }),
  defineValibotMcpTool({
    annotations: {
      title: "Fetch",
      destructiveHint: false,
      readOnlyHint: true,
      openWorldHint: false,
    },
    access: "read",
    anonymized: { exposure: "passthrough" },
    description:
      "Fetch one public-corpus document by id using the OpenAI-compatible fetch " +
      `tool shape. ${COMPAT_CORPUS_ID_VOCABULARY} A decision answers with its text, a ` +
      "statute with the text in force today, and `metadata.kind` says which. Long text " +
      "is returned in windows; pass the returned nextCursor back as cursor to read more.",
    feature: "FEATURE_PUBLIC_LAW",
    inputSchema: lawCompatFetchArgsSchema,
    name: "fetch",
    scope: "stella:read",
  }),
] as const satisfies readonly McpToolDefinition[];

const handleLawCompatSearchTool: McpToolHandler<
  v.InferInput<typeof COMPAT_SEARCH_OUTPUT_SCHEMA>
> = async ({ args, context }) => {
  const parsed = v.safeParse(lawCompatSearchArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const { cursor, query } = parsed.output;

  const position = decodeCompatSearchCursor(cursor);
  if (position === null) {
    return compatSearchCursorError();
  }

  const corpus = await searchCompatCorpus({
    context,
    countries: await resolveCompatCorpusCountries(context),
    cursors: position.corpus,
    query,
  });
  if (corpus.type === "failed") {
    return errorResult(corpus.message);
  }

  // The corpus results are public law, so the egress pipeline passes them
  // through as written; the plan still runs through it so both audiences
  // serialize the same way.
  return {
    egress: "compatSearch",
    nextCursor: hasMoreCorpusPages(corpus.cursors)
      ? encodeCompatSearchCursor({ matter: null, corpus: corpus.cursors })
      : null,
    results: corpus.results,
  };
};

const handleLawCompatFetchTool: McpToolHandler<
  v.InferInput<typeof LAW_COMPAT_FETCH_OUTPUT_SCHEMA>
> = async ({ args, context }) => {
  const parsed = v.safeParse(lawCompatFetchArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues, COMPAT_CORPUS_ID_HINT);
  }
  const { cursor, id: rawId } = parsed.output;
  const compatId = decodeCompatCorpusId(rawId);
  if (compatId === null) {
    return invalidCompatIdResult(COMPAT_CORPUS_ID_HINT);
  }

  return await compatCorpusFetchResponse({ compatId, context, cursor });
};

export const LAW_COMPAT_TOOL_HANDLERS = {
  fetch: handleLawCompatFetchTool,
  search: handleLawCompatSearchTool,
} satisfies Record<LawCompatToolName, McpToolHandler>;

export const LAW_COMPAT_TOOL_SET = defineMcpToolSet(
  LAW_COMPAT_TOOL_DEFINITIONS,
  LAW_COMPAT_TOOL_HANDLERS,
  {
    fetch: defineMcpToolOutput(LAW_COMPAT_FETCH_OUTPUT_SCHEMA),
    search: defineMcpToolOutput(COMPAT_SEARCH_OUTPUT_SCHEMA),
  },
);
