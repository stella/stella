import { panic } from "better-result";

import {
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
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

export const compatSearchCursorError = () =>
  structuredErrorResult({
    code: "validation_error",
    message: "Invalid cursor",
    issues: [{ path: "cursor", message: "Invalid cursor" }],
    hint: "Pass the 'cursor' verbatim as returned by a previous call, or omit it for the first page.",
  });

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
      };
    default:
      read satisfies never;
      return panic("Unhandled compat corpus read");
  }
};
