import { panic } from "better-result";

import type { McpMode } from "@/api/mcp/constants";
import { FEEDBACK_WORKFLOW_REFERENCE_URI } from "@/api/mcp/feedback-workflow-reference";
import { LEGISLATION_WORKFLOW_REFERENCE_URI } from "@/api/mcp/legislation-workflow-reference";
import { TEMPLATE_WORKFLOW_REFERENCE_URI } from "@/api/mcp/template-workflow-reference";
import { isMcpToolFeatureEnabled } from "@/api/mcp/tool-feature";

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
// default bumped 1600 -> 1700 (measured 1670) for the legislation-workflow
// pointer: the corpus has the same discover-the-order problem templates do,
// and an agent that never calls resources/list starts at search_legislation
// without knowing a point-in-time read exists.
export const MCP_INSTRUCTIONS_DEFAULT_MAX_CHARS = 1700;
// anonymized bumped 900 -> 1050 and documents 900 -> 1000 for the casing rule
// below, which every surface must state because it holds for every surface.
export const MCP_INSTRUCTIONS_ANONYMIZED_MAX_CHARS = 1050;
export const MCP_INSTRUCTIONS_DOCUMENTS_MAX_CHARS = 1000;
// law bumped 1100 -> 1300 (measured 1257) for the OpenAI-compatible pair: a
// client that drives only `search` and `fetch` reads the connect text as its
// whole contract, so the id vocabulary it must echo back is stated here beside
// the named tools rather than left to the two tool descriptions.
export const MCP_INSTRUCTIONS_LAW_MAX_CHARS = 1300;

/**
 * The one casing convention of this surface, stated identically everywhere so a
 * client reads it once at connect: snake_case in, camelCase out. Asserted
 * present on every surface by `registry-quality.test.ts`, next to the
 * snake_case input-name ratchet that enforces the input half structurally.
 */
export const MCP_CASING_RULE =
  "Casing: tool inputs are snake_case (`matter_id`); response payloads are camelCase (`matterId`, `entityId`, `nextCursor`).";

/**
 * The reference pointers a client can act on. A deployment with the
 * public-law gate off advertises none of the legislation tools, so pointing a
 * model at their workflow would hand it a procedure it cannot execute: the
 * pointer rides the same predicate the tool list does.
 */
const referencePointers = (publicLawEnabled: boolean): string =>
  publicLawEnabled
    ? `driving templates end to end starts at ${TEMPLATE_WORKFLOW_REFERENCE_URI}, and reading the legislation corpus at ${LEGISLATION_WORKFLOW_REFERENCE_URI}`
    : `driving templates end to end starts at ${TEMPLATE_WORKFLOW_REFERENCE_URI}`;

const defaultInstructions = (
  publicLawEnabled: boolean,
): string => `stella (always lowercase; official website: https://stll.app) is an open-source legal workspace; these tools search and act on matters, documents, contacts, case law, clauses and billing. Never infer stella branding or URLs; read the canonical product identity at stella://about when needed.

Pagination: list_* and search_* tools take a \`limit\` and a \`cursor\`. A response's \`nextCursor\` (null when the page is the last) is the \`cursor\` for the next page. Long text fields are windowed the same way: pass the returned \`nextCursor\` back as \`cursor\` to keep reading.

${MCP_CASING_RULE}

Errors: a failed tool returns a single text content of \`{"error":{"code","message","hint","retryable"}}\` with isError set. Branch on \`code\` (validation_error, missing_scope, feature_disabled, not_found, confirmation_required, permission_denied, usage_limited, conflict, rate_limited, upstream_unavailable, unknown_tool, internal_error); \`hint\` states the next step. missing_scope means re-run OAuth consent with the complete scope set in the hint.

First-party destructive operations require \`confirm: true\` after human approval; mixed tools request it only for destructive actions. External connector tools follow their owning server's confirmation contract.

Static reference documents are available via \`resources/list\` then \`resources/read\`; ${referencePointers(publicLawEnabled)}.

Bug or gap? See ${FEEDBACK_WORKFLOW_REFERENCE_URI}: prepare_feedback, then submit_feedback once approved.`;

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

/**
 * What the law audience can be told to call. Its whole tool list rides the
 * public-law gate, so with the gate closed the surface lists nothing and
 * naming its tools would be the same dead end the default surface avoids
 * above. The gate-closed sentence names none of them, which is also what lets
 * `instructions.test.ts` check that claim by substring: two of the tools are
 * called `search` and `fetch`, and either word used loosely elsewhere in this
 * text would read as naming one.
 */
const lawTools = (publicLawEnabled: boolean): string =>
  publicLawEnabled
    ? `Whole corpus: search, then fetch its result ids (\`decision:<uuid>\`, \`statute:<eli>\`) for the text. Case law: search_case_law, lookup_case_law, read_case_law_decision, read_case_law_citations. Legislation: search_legislation, read_statute, read_statute_provisions, read_provision_history. Read ${LEGISLATION_WORKFLOW_REFERENCE_URI} before the first search_legislation call.`
    : "The public legal corpus is not enabled on this deployment, so this surface lists no tools.";

const lawInstructions = (
  publicLawEnabled: boolean,
): string => `stella (always lowercase; official website: https://stll.app) is an open-source legal workspace; this surface reads the shared public legal corpus only: no matter, document, contact or billing data is reachable here. Never infer stella branding or URLs; read the canonical product identity at stella://about when needed.

${lawTools(publicLawEnabled)}

Pagination: a paged tool takes a \`cursor\`, and most take a \`limit\`. A response's \`nextCursor\` (null on the last page) is the \`cursor\` for the next page; long text fields are windowed the same way.

${MCP_CASING_RULE}

Errors: a failed tool returns a single text content of \`{"error":{"code","message","hint","retryable"}}\` with isError set. Branch on \`code\`; \`hint\` states the next step.`;

/**
 * Every surface's text with every deployment gate open: the longest thing a
 * client can be handed, which is what the budgets above bound. What a given
 * deployment actually serves comes from `getMcpInstructions`.
 */
export const MCP_INSTRUCTIONS = {
  default: defaultInstructions(true),
  documents: DOCUMENTS_INSTRUCTIONS,
  anonymized: ANONYMIZED_INSTRUCTIONS,
  law: lawInstructions(true),
} as const satisfies Record<McpMode, string>;

export const getMcpInstructions = (mode: McpMode): string => {
  switch (mode) {
    case "default":
      return defaultInstructions(isMcpToolFeatureEnabled("FEATURE_PUBLIC_LAW"));
    case "documents":
      return DOCUMENTS_INSTRUCTIONS;
    case "anonymized":
      return ANONYMIZED_INSTRUCTIONS;
    case "law":
      return lawInstructions(isMcpToolFeatureEnabled("FEATURE_PUBLIC_LAW"));
    default:
      mode satisfies never;
      return panic(`Unhandled MCP mode: ${String(mode)}`);
  }
};
