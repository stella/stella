import type { StellaMcpAppCall } from "@stll/api-contract/stella-mcp-app";

/**
 * How a chat thread first shows one of stella's own apps. Most apps open in
 * place, because they are the answer the reader came for. A case-law result
 * list is a working surface (a search box, filters and a table) beside an
 * answer that already cites what mattered, so it starts as one line the
 * reader can open.
 */
export type StellaAppDisclosure =
  | { type: "open" }
  | { type: "case-law"; query: string; decisionCount: number | null };

const CASE_LAW_RESULTS_DIRECTORY = "case-law-results";

const queryText = (input: Record<string, unknown>): string => {
  const { queries, query } = input;
  if (Array.isArray(queries)) {
    return queries
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .join(" · ");
  }
  if (typeof queries === "string") {
    return queries.trim();
  }
  return typeof query === "string" ? query.trim() : "";
};

const decisionCount = (
  structuredContent: Record<string, unknown>,
): number | null => {
  const { results } = structuredContent;
  return Array.isArray(results) ? results.length : null;
};

/** `directory` is the app's name under the stella app URI prefix. */
export const stellaAppDisclosure = (
  directory: string | null,
  call: StellaMcpAppCall,
): StellaAppDisclosure =>
  directory === CASE_LAW_RESULTS_DIRECTORY
    ? {
        type: "case-law",
        query: queryText(call.input),
        decisionCount: decisionCount(call.result.structuredContent),
      }
    : { type: "open" };
