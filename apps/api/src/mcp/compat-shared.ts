import { panic } from "better-result";

import { PUBLIC_CASE_LAW_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";
import { PUBLIC_LEGISLATION_COUNTRIES } from "@stll/api-contract/legislation-publication";

import {
  CORPUS_SEARCH_CURSOR_WITH_GROUPS_MAX_LENGTH,
  CORPUS_SEARCH_CURSOR_WITH_PHASE_MAX_LENGTH,
} from "@/api/lib/legal-search/corpus-search-cursor";
import { LIMITS } from "@/api/lib/limits";
import {
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import {
  getTenantActionSizePolicy,
  normalizeTenantPageLimit as normalizePage,
} from "@/api/lib/rate-limit/action-size-limits";
import { encodeCursor } from "@/api/lib/search/cursor";
import {
  EMPTY_CORPUS_CURSORS,
  readCompatDecision,
  readCompatStatute,
  type CompatCorpusCursors,
  type CorpusSubCursors,
} from "@/api/mcp/compat-corpus";
import { encodeCompatId, type CompatCorpusId } from "@/api/mcp/compat-ids";
import type { McpRequestContext } from "@/api/mcp/context";
import type { McpToolResponse } from "@/api/mcp/tool-types";
import {
  invalidCursorResult,
  FEATURE_DISABLED_MESSAGE,
  featureDisabledHint,
  MCP_CONTENT_MAX_CHARS,
  notFoundResult,
  structuredErrorResult,
} from "@/api/mcp/tool-utils";

/**
 * What the two audiences serving the OpenAI-compatible pair share: the merged
 * cursor its `search` pages with, the corpus half of its `fetch`, and the
 * refusals both spell the same way. The audiences differ only in what they
 * read, never in how they answer.
 */

export type CompatSearchPosition = {
  /**
   * Three states, as in the corpus sub-cursors: a string continues the
   * matter-knowledge provider, `undefined` is its first page, and `null` means
   * its pages ended on an earlier call.
   */
  matter: string | null | undefined;
  corpus: CompatCorpusCursors;
};

/**
 * The merged cursor carries one sub-cursor per source, JSON-wrapped and
 * base64url-encoded by the shared pagination codec: the same envelope
 * `search_case_law` uses for its per-query cursor. Each source's position is
 * its own, so a page's contents come from wherever each source had got to.
 */
export const encodeCompatSearchCursor = ({
  corpus,
  matter,
}: {
  corpus: CompatCorpusCursors;
  matter: string | null;
}): string =>
  encodePaginationCursor([matter, corpus.decisions, corpus.statutes]);

// Base64 sub-cursors need no JSON escaping. Running the actual wrapper over
// their bounds includes country keys, separators and base64url framing exactly.
const maximumCorpusCursors = {
  decisions: Object.fromEntries(
    PUBLIC_CASE_LAW_COUNTRIES.map((country) => [
      country,
      "a".repeat(CORPUS_SEARCH_CURSOR_WITH_GROUPS_MAX_LENGTH),
    ]),
  ),
  statutes: Object.fromEntries(
    PUBLIC_LEGISLATION_COUNTRIES.map((country) => [
      country,
      "a".repeat(CORPUS_SEARCH_CURSOR_WITH_PHASE_MAX_LENGTH),
    ]),
  ),
};

export const LAW_COMPAT_SEARCH_CURSOR_MAX_LENGTH = encodeCompatSearchCursor({
  matter: null,
  corpus: maximumCorpusCursors,
}).length;

export const COMPAT_SEARCH_CURSOR_MAX_LENGTH = encodeCompatSearchCursor({
  // The knowledge provider emits a finite score and an entity UUID.
  matter: encodeCursor(
    -0.0000012345678901234567,
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
  ),
  corpus: maximumCorpusCursors,
}).length;

const readSubCursors = (value: unknown): CorpusSubCursors | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const cursors: Record<string, string | null> = {};
  const entries: [string, unknown][] = Object.entries(value);
  for (const [country, cursor] of entries) {
    if (cursor !== null && typeof cursor !== "string") {
      return null;
    }
    cursors[country] = cursor;
  }
  return cursors;
};

/** The position a cursor names, or null when it is not one this pair issued. */
export const decodeCompatSearchCursor = (
  cursor: string | undefined,
): CompatSearchPosition | null => {
  if (cursor === undefined) {
    return { matter: undefined, corpus: EMPTY_CORPUS_CURSORS };
  }
  const parts = decodePaginationCursor(cursor);
  if (!parts || parts.length !== 3) {
    return null;
  }
  const [matter, decisions, statutes] = parts;
  if (matter !== null && typeof matter !== "string") {
    return null;
  }
  const decisionCursors = readSubCursors(decisions);
  const statuteCursors = readSubCursors(statutes);
  if (decisionCursors === null || statuteCursors === null) {
    return null;
  }
  return {
    matter,
    corpus: { decisions: decisionCursors, statutes: statuteCursors },
  };
};

export const compatSearchCursorError = (cursor: string) =>
  invalidCursorResult({ cursor });

/**
 * A malformed id is a validation issue at the boundary, never a database cast
 * error: the id vocabulary is read before anything reaches SQL, and the hint
 * names the call that mints a valid id.
 */
export const invalidCompatIdResult = (hint: string) =>
  structuredErrorResult({
    code: "validation_error",
    message: "Invalid id",
    issues: [{ path: "id", message: "Invalid id" }],
    hint,
  });

export const publicLawDisabledResult = (feature: string) =>
  structuredErrorResult({
    code: "feature_disabled",
    message: FEATURE_DISABLED_MESSAGE,
    hint: featureDisabledHint(feature),
  });

/**
 * The corpus half of `fetch`. The read is the same gated read the named corpus
 * tools do, and the plan it returns declares the subject kind, which is both
 * what the egress pipeline decides anonymization by and the `metadata.kind`
 * the client reads.
 */
export const compatCorpusFetchResponse = async <TData>({
  compatId,
  context,
  cursor,
}: {
  compatId: CompatCorpusId;
  context: McpRequestContext;
  cursor: string | undefined;
}): Promise<McpToolResponse<TData>> => {
  const read = await (compatId.kind === "decision"
    ? readCompatDecision({ context, decisionId: compatId.decisionId })
    : readCompatStatute({ context, eli: compatId.eli }));

  switch (read.type) {
    case "not_found":
      return notFoundResult(
        compatId.kind === "decision"
          ? "No decision the public may read has this id"
          : "No statute the public may read has this eli",
        "Find one with search and pass the id it returns.",
      );
    case "withheld":
      return structuredErrorResult({
        code: "permission_denied",
        message: "The source licence does not permit AI use of the full text",
        hint: `Read it at ${read.url} instead; this tool cannot return the wording.`,
      });
    case "read":
      return {
        egress: "compatFetch",
        cursor,
        id: encodeCompatId(compatId),
        maxChars: MCP_CONTENT_MAX_CHARS,
        subject: { kind: compatId.kind },
        text: read.text,
        title: read.title,
        url: read.url,
        ...(read.source_url === undefined
          ? {}
          : { source_url: read.source_url }),
      };
    default:
      read satisfies never;
      return panic("Unhandled compat corpus read");
  }
};

// The shared corpus cursor advances every fetched country page. Refuse a
// budget that cannot emit those pages whole rather than dropping cursor hits.
export const compatSearchPageLimitResult = (audience: "tenant" | "law") => {
  const policy = getTenantActionSizePolicy();
  if (policy === undefined) {
    return null;
  }
  const matterLimit =
    audience === "tenant"
      ? normalizePage(LIMITS.mcpCompatSearchPageSizeDefault)
      : 0;
  const combinedLimit =
    matterLimit +
    LIMITS.mcpCompatDecisionPageSizeDefault +
    LIMITS.mcpCompatStatutePageSizeDefault;
  if (combinedLimit <= policy.pageSize) {
    return null;
  }
  return structuredErrorResult({
    code: "validation_error",
    message:
      "The configured page limit cannot include the combined search page",
    hint: "Use search_case_law or search_legislation with an explicit smaller limit; search matters separately with search_across_matters.",
  });
};
