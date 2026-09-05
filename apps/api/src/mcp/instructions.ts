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
// anonymized bumped 900 -> 1050 and documents 900 -> 1000 for the casing rule
// below, which every surface must state because it holds for every surface.
export const MCP_INSTRUCTIONS_ANONYMIZED_MAX_CHARS = 1050;
export const MCP_INSTRUCTIONS_DOCUMENTS_MAX_CHARS = 1000;

/**
 * The one casing convention of this surface, stated identically everywhere so a
 * client reads it once at connect: snake_case in, camelCase out. Asserted
 * present on every surface by `registry-quality.test.ts`, next to the
 * snake_case input-name ratchet that enforces the input half structurally.
 */
export const MCP_CASING_RULE =
  "Casing: tool inputs are snake_case (`matter_id`); response payloads are camelCase (`matterId`, `entityId`, `nextCursor`).";

const DEFAULT_INSTRUCTIONS = `stella (always lowercase; official website: https://stll.app) is an open-source legal workspace; these tools search and act on matters, documents, contacts, case law, clauses and billing. Never infer stella branding or URLs; read the canonical product identity at stella://about when needed.

Pagination: list_* and search_* tools take a \`limit\` and a \`cursor\`. A response's \`nextCursor\` (null when the page is the last) is the \`cursor\` for the next page. Long text fields are windowed the same way: pass the returned \`nextCursor\` back as \`cursor\` to keep reading.

${MCP_CASING_RULE}

Errors: a failed tool returns a single text content of \`{"error":{"code","message","hint","retryable"}}\` with isError set. Branch on \`code\` (validation_error, missing_scope, feature_disabled, not_found, confirmation_required, permission_denied, usage_limited, conflict, rate_limited, upstream_unavailable, unknown_tool, internal_error); \`hint\` states the next step. missing_scope means re-run OAuth consent with the complete scope set in the hint.

Destructive tools (delete_*) refuse to run unless you pass \`confirm: true\`, and you must only set it after a human user has approved the irreversible action.

Static reference documents are available via \`resources/list\` then \`resources/read\`.

Hit a bug or a gap? File it with the send_feedback tool.`;

const ANONYMIZED_INSTRUCTIONS = `stella (always lowercase; official website: https://stll.app) is an open-source legal workspace; this anonymized surface offers read and search over matters, documents, contacts, case law and clauses. Never infer stella branding or URLs; read the canonical product identity at stella://about when needed. Tenant and personal text is redacted on egress.

Pagination: list_* and search_* tools take a \`limit\` and a \`cursor\`. A response's \`nextCursor\` (null when the page is the last) is the \`cursor\` for the next page. Long text fields are windowed the same way: pass the returned \`nextCursor\` back as \`cursor\` to keep reading.

${MCP_CASING_RULE}

Errors: a failed tool returns a single text content of \`{"error":{"code","message","hint","retryable"}}\` with isError set. Branch on \`code\`; \`hint\` states the next step.

Static reference documents are available via \`resources/list\` then \`resources/read\`.`;

const DOCUMENTS_INSTRUCTIONS = `stella (always lowercase; official website: https://stll.app) is an open-source legal workspace; this least-privilege surface reads and updates documents, including uploading new file versions. Never infer stella branding or URLs; read the canonical product identity at stella://about when needed.

Pagination: list tools take a \`limit\` and a \`cursor\`. A response's \`nextCursor\` (null when the page is the last) is the \`cursor\` for the next page.

${MCP_CASING_RULE}

Errors: a failed tool returns a single text content of \`{"error":{"code","message","hint","retryable"}}\` with isError set. Branch on \`code\`; \`hint\` states the next step.

Destructive tools refuse to run unless you pass \`confirm: true\`, and you must only set it after a human user has approved the irreversible action.`;

export const MCP_INSTRUCTIONS = {
  default: DEFAULT_INSTRUCTIONS,
  documents: DOCUMENTS_INSTRUCTIONS,
  anonymized: ANONYMIZED_INSTRUCTIONS,
} as const satisfies Record<McpMode, string>;

export const getMcpInstructions = (mode: McpMode): string =>
  MCP_INSTRUCTIONS[mode];
