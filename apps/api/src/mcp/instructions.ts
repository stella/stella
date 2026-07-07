import type { McpMode } from "@/api/mcp/constants";

/**
 * Server-level `instructions` handed to MCP clients at connect time (the MCP
 * `initialize` response). The Stella MCP surface is driven almost entirely by
 * AI agents, so these tell an agent the conventions it cannot infer from the
 * tool list alone: pagination/windowing, the structured error envelope, the
 * destructive-op confirm gate, and where static reference docs live.
 *
 * Kept terse and factual (no marketing). Hard budgets guard against drift and
 * token bloat and are asserted in `instructions.test.ts`.
 */
export const MCP_INSTRUCTIONS_DEFAULT_MAX_CHARS = 1600;
export const MCP_INSTRUCTIONS_ANONYMIZED_MAX_CHARS = 900;

const DEFAULT_INSTRUCTIONS = `Stella is a legal workspace; these tools search and act on matters, documents, contacts, case law, clauses and billing.

Pagination: list_* and search_* tools take a \`limit\` and a \`cursor\`. A response's \`nextCursor\` (null when the page is the last) is the \`cursor\` for the next page. Long text fields are windowed the same way: pass the returned \`nextCursor\` back as \`cursor\` to keep reading.

Errors: a failed tool returns a single text content of \`{"error":{"code","message","hint","retryable"}}\` with isError set. Branch on \`code\` (validation_error, missing_scope, feature_disabled, not_found, confirmation_required, rate_limited, unknown_tool, internal_error); \`hint\` states the next step. missing_scope means re-run OAuth consent with the named scope (CLI: \`stella auth login --scopes <scope>\`).

Destructive tools (delete_*) refuse to run unless you pass \`confirm: true\`, and you must only set it after a human user has approved the irreversible action.

Static reference documents are available via \`resources/list\` then \`resources/read\`.

Hit a bug or a gap? File it with the send_feedback tool.`;

const ANONYMIZED_INSTRUCTIONS = `Stella is a legal workspace; this anonymized surface offers read and search over matters, documents, contacts, case law and clauses. Tenant and personal text is redacted on egress.

Pagination: list_* and search_* tools take a \`limit\` and a \`cursor\`. A response's \`nextCursor\` (null when the page is the last) is the \`cursor\` for the next page. Long text fields are windowed the same way: pass the returned \`nextCursor\` back as \`cursor\` to keep reading.

Errors: a failed tool returns a single text content of \`{"error":{"code","message","hint","retryable"}}\` with isError set. Branch on \`code\`; \`hint\` states the next step.

Static reference documents are available via \`resources/list\` then \`resources/read\`.`;

export const MCP_INSTRUCTIONS: Record<McpMode, string> = {
  default: DEFAULT_INSTRUCTIONS,
  anonymized: ANONYMIZED_INSTRUCTIONS,
};

export const getMcpInstructions = (mode: McpMode): string =>
  MCP_INSTRUCTIONS[mode];
