import type { McpToolName } from "@/api/mcp/static-tool-names";

/**
 * How long one MCP `tools/call` may take, per tool. The one table.
 *
 * Three readers keep a tool from turning slow unnoticed, and all of them read
 * this table rather than a number of their own:
 *
 * - the deployed MCP canary (`scripts/mcp-canary.ts`) fails a tool call that
 *   answered over its budget, so a slow tool blocks the release proof;
 * - the API's `mcp.request.phases` record carries `budget` and `overBudget`,
 *   which a log metric filter counts;
 * - a `tools/call` runs inside a request latency scope of this budget
 *   (`lib/load/request-latency-budget.ts`), so the corpus client and the public-law
 *   transaction deadline give up inside it rather than outwaiting the caller.
 *
 * Keys are the names the phases record reports (`classifyMcpMetricToolName`):
 * a static tool name, or the `external_mcp`, `skill` and `unknown` buckets
 * dynamic names fold into. A tool not listed gets the default.
 *
 * An override is for a tool whose work is long by design, and says why. It is
 * never a way to quiet a tool that got slower: that is a regression to fix.
 */
export type McpToolLatencyBudgetKey =
  McpToolName | "external_mcp" | "skill" | "unknown";

type McpToolLatencyOverride = {
  readonly budgetMs: number;
  /** What makes this tool's work longer than an ordinary read or write. */
  readonly reason: string;
};

/**
 * Interactive reads and writes: one tenant or corpus lookup and a small
 * projection. Deployed reads of this kind answer well under a second at
 * their 99th percentile; the default leaves room for a cold handler graph
 * and transport, and nothing more.
 */
export const MCP_TOOL_LATENCY_DEFAULT_BUDGET_MS = 2000;

/** A corpus or workspace search: an index scan plus row hydration. */
const SEARCH_BUDGET_MS = 8000;

/**
 * The tools whose work is long by design. Every other key gets the default,
 * so the record below is total over exactly these: a name missing from
 * either side, or one that is not a tool, fails to compile.
 */
type LongByDesignTool = Extract<
  McpToolLatencyBudgetKey,
  | "search"
  | "search_case_law"
  | "search_legislation"
  | "search_boe_legislation"
  | "search_across_matters"
  | "lookup_business_registry"
  | "read_case_law_decision"
  | "preview_template_conditions"
  | "read_content_across_matters"
  | "external_mcp"
  | "create_template"
  | "prepare_file_comparison_from_links"
  | "upload_document_version"
  | "save_filled_template"
  | "compare_documents"
>;

export const MCP_TOOL_LATENCY_BUDGET_OVERRIDES = {
  search: {
    budgetMs: SEARCH_BUDGET_MS,
    reason:
      "Searches case law and legislation for the OpenAI-compatible search surface in one call.",
  },
  search_case_law: {
    budgetMs: SEARCH_BUDGET_MS,
    reason:
      "Scans the case-law corpus index and hydrates the page from the corpus database.",
  },
  search_legislation: {
    budgetMs: SEARCH_BUDGET_MS,
    reason:
      "Scans the legislation corpus index, hydrates candidates and collapses them to one hit per work.",
  },
  search_boe_legislation: {
    budgetMs: SEARCH_BUDGET_MS,
    reason: "Searches the Spanish official gazette's open-data API upstream.",
  },
  search_across_matters: {
    budgetMs: SEARCH_BUDGET_MS,
    reason: "Full-text search over every matter the caller can read.",
  },
  lookup_business_registry: {
    budgetMs: SEARCH_BUDGET_MS,
    reason: "Queries a public business registry over the network.",
  },
  read_case_law_decision: {
    budgetMs: SEARCH_BUDGET_MS,
    reason:
      "A decision whose text is not stored yet waits up to six seconds for the publisher before answering without it.",
  },
  preview_template_conditions: {
    budgetMs: 15_000,
    reason:
      "Asks a model to evaluate the template's conditions, bounded at ten seconds.",
  },
  read_content_across_matters: {
    budgetMs: 35_000,
    reason:
      "Converts a stored DOCX to Markdown on read, bounded at thirty seconds.",
  },
  external_mcp: {
    budgetMs: 35_000,
    reason:
      "Proxied to an MCP server the organization connected; its latency is the upstream's.",
  },
  create_template: {
    budgetMs: 65_000,
    reason:
      "Downloads the template file from the host, bounded at sixty seconds.",
  },
  prepare_file_comparison_from_links: {
    budgetMs: 125_000,
    reason:
      "Transfers both linked files into storage, each bounded at sixty seconds.",
  },
  upload_document_version: {
    budgetMs: 125_000,
    reason:
      "Downloads the file from the host and uploads it to storage, each bounded at sixty seconds.",
  },
  save_filled_template: {
    budgetMs: 330_000,
    reason:
      "Renders the filled document, capped at five minutes, then persists it; the CLI leaf grants the same.",
  },
  compare_documents: {
    budgetMs: 600_000,
    reason:
      "Runs the document comparison synchronously; the HTTP route and CLI leaf grant it the same ten minutes.",
  },
} as const satisfies Record<LongByDesignTool, McpToolLatencyOverride>;

const hasOverride = (
  toolName: string,
): toolName is keyof typeof MCP_TOOL_LATENCY_BUDGET_OVERRIDES =>
  Object.hasOwn(MCP_TOOL_LATENCY_BUDGET_OVERRIDES, toolName);

/** The budget of the tool the phases record names; the default when unlisted. */
export const mcpToolLatencyBudgetMs = (toolName: string): number =>
  hasOverride(toolName)
    ? MCP_TOOL_LATENCY_BUDGET_OVERRIDES[toolName].budgetMs
    : MCP_TOOL_LATENCY_DEFAULT_BUDGET_MS;

type McpToolLatencyVerdict = {
  toolName: string;
  elapsedMs: number;
  budgetMs: number;
  overBudget: boolean;
};

/** One call judged against its tool's budget; equal to the budget is within it. */
export const judgeMcpToolLatency = ({
  toolName,
  elapsedMs,
}: {
  toolName: string;
  elapsedMs: number;
}): McpToolLatencyVerdict => {
  const budgetMs = mcpToolLatencyBudgetMs(toolName);
  return { toolName, elapsedMs, budgetMs, overBudget: elapsedMs > budgetMs };
};
