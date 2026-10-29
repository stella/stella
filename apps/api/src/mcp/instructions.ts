import { panic } from "better-result";

import type { McpMode } from "@/api/mcp/constants";
import {
  listMcpResources,
  scopeMcpResourceReferences,
} from "@/api/mcp/resources";
import type { ResourceContext } from "@/api/mcp/resources";
import { surfaceToolVocabulary } from "@/api/mcp/surface-tool-mentions";
import { isMcpToolFeatureEnabled } from "@/api/mcp/tool-feature";
import { scopeProseToSurface } from "@/api/mcp/tool-mentions";

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
// Hard caps per audience. The measured lengths are rows of
// `apps/api/mcp-surface-baseline.json`, where a change shows as a number diff.
export const MCP_INSTRUCTIONS_DEFAULT_MAX_CHARS = 1700;
export const MCP_INSTRUCTIONS_ADVANCED_MAX_CHARS = 1800;
export const MCP_INSTRUCTIONS_ANONYMIZED_MAX_CHARS = 1050;
export const MCP_INSTRUCTIONS_DOCUMENTS_MAX_CHARS = 1000;
export const MCP_INSTRUCTIONS_LAW_MAX_CHARS = 1300;

/**
 * The one casing convention of this surface, stated identically everywhere so a
 * client reads it once at connect: snake_case in, camelCase out. Asserted
 * present on every surface by `registry-quality.test.ts`, next to the
 * snake_case input-name ratchet that enforces the input half structurally.
 */
export const MCP_CASING_RULE =
  "Casing: tool inputs are snake_case (`matter_id`); response payloads are camelCase (`matterId`, `entityId`, `nextCursor`).";

const defaultInstructions = (
  mode: "advanced" | "default",
): string => `stella (always lowercase; official website: https://stll.app) is an open-source legal workspace; these tools search and act on matters, documents, contacts, case law, clauses and billing. Never infer stella branding or URLs; read the canonical product identity resource when needed.

Pagination: list_* and search_* tools take a \`limit\` and a \`cursor\`. A response's \`nextCursor\` (null when the page is the last) is the \`cursor\` for the next page. Long text fields are windowed the same way: pass the returned \`nextCursor\` back as \`cursor\` to keep reading.

${MCP_CASING_RULE}

Errors: failed tools return text \`{"error":{"code","message","hint","retryable"}}\` with isError set. Follow \`hint\`; result_too_large needs a smaller selection or page; missing_scope needs OAuth consent with every scope in the hint. Success with applied:true and resultOmitted:true means the action completed; inspect it with a read tool, never repeat it.

First-party destructive operations require \`confirm: true\` after human approval; mixed tools request it only for destructive actions.${mode === "advanced" ? " External connector tools follow their owning server's confirmation contract." : ""}

Bug or gap? Call prepare_feedback, then submit_feedback once approved.`;

const ANONYMIZED_INSTRUCTIONS = `stella (always lowercase; official website: https://stll.app) is an open-source legal workspace; this anonymized surface offers read and search over matters, documents, contacts, case law and clauses. Never infer stella branding or URLs; read the canonical product identity resource when needed. Tenant and personal text is redacted on egress.

Pagination: list_* and search_* tools take a \`limit\` and a \`cursor\`. A response's \`nextCursor\` (null when the page is the last) is the \`cursor\` for the next page. Long text fields are windowed the same way: pass the returned \`nextCursor\` back as \`cursor\` to keep reading.

${MCP_CASING_RULE}

Errors: a failed tool returns a single text content of \`{"error":{"code","message","hint","retryable"}}\` with isError set. Branch on \`code\`; \`hint\` states the next step.`;

const DOCUMENTS_INSTRUCTIONS = `stella (always lowercase; official website: https://stll.app) is an open-source legal workspace; this least-privilege surface reads and updates documents, including uploading new file versions. Never infer stella branding or URLs; read the canonical product identity resource when needed.

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
    ? "Corpus: search, then fetch ids (`decision:<uuid>`, `statute:<eli>`). Case law: search_case_law, resolve_case_law_decision, read_case_law_decision, read_case_law_citations, open_case_law_decision for the user; case_law_coverage before declaring a decision absent. Legislation: resolve_law_citation for a provision, search_legislation, read_statute, read_statute_provisions, read_provision_history."
    : "The public legal corpus is not enabled on this deployment, so this surface lists no tools.";

const lawInstructions = (
  publicLawEnabled: boolean,
): string => `stella (always lowercase; official website: https://stll.app) is an open-source legal workspace; this surface reads the public legal corpus: no matter, document, contact or billing data is reachable here. Never infer stella branding or URLs; read the canonical product identity resource when needed.

${lawTools(publicLawEnabled)}

Pagination: a paged tool takes a \`cursor\`, and most take a \`limit\`. A response's \`nextCursor\` (null on the last page) is the \`cursor\` for the next page; long text fields are windowed the same way.

${MCP_CASING_RULE}

Errors: a failed tool returns a single text content of \`{"error":{"code","message","hint","retryable"}}\` with isError set. Branch on \`code\`; \`hint\` states the next step.`;

const renderMcpInstructionBody = (
  mode: McpMode,
  publicLawEnabled: boolean,
): string => {
  switch (mode) {
    case "advanced":
    case "default":
      return defaultInstructions(mode);
    case "documents":
      return DOCUMENTS_INSTRUCTIONS;
    case "anonymized":
      return ANONYMIZED_INSTRUCTIONS;
    case "law":
      return lawInstructions(publicLawEnabled);
    default:
      mode satisfies never;
      return panic(`Unhandled MCP mode: ${String(mode)}`);
  }
};

type RenderMcpInstructionsOptions = {
  mode: McpMode;
  context?: ResourceContext | undefined;
  isFeatureEnabled: typeof isMcpToolFeatureEnabled;
};

const resourcePointerLine = async ({
  mode,
  context,
  isFeatureEnabled,
}: RenderMcpInstructionsOptions): Promise<string> => {
  const resources = await listMcpResources(mode, { context, isFeatureEnabled });
  return `Resources (call \`resources/list\`, then \`resources/read\`): ${resources
    .map(({ name }) => name)
    .join(", ")}.`;
};

const renderMcpInstructions = async (
  options: RenderMcpInstructionsOptions,
): Promise<string> =>
  `${renderMcpInstructionBody(options.mode, options.isFeatureEnabled("FEATURE_PUBLIC_LAW"))}\n\n${await resourcePointerLine(options)}`;

/**
 * Every surface's text with every deployment gate open: the longest thing a
 * client can be handed, which is what the budgets above bound. What a given
 * deployment actually serves comes from `getMcpInstructions`.
 */
export const MCP_INSTRUCTIONS = {
  advanced: await renderMcpInstructions({
    mode: "advanced",
    isFeatureEnabled: () => true,
  }),
  default: await renderMcpInstructions({
    mode: "default",
    isFeatureEnabled: () => true,
  }),
  documents: await renderMcpInstructions({
    mode: "documents",
    isFeatureEnabled: () => true,
  }),
  anonymized: await renderMcpInstructions({
    mode: "anonymized",
    isFeatureEnabled: () => true,
  }),
  law: await renderMcpInstructions({
    mode: "law",
    isFeatureEnabled: () => true,
  }),
} as const satisfies Record<McpMode, string>;

export const getMcpInstructions = async (
  mode: McpMode,
  context?: ResourceContext,
): Promise<string> => {
  const text = await scopeMcpResourceReferences(
    await renderMcpInstructions({
      mode,
      context,
      isFeatureEnabled: isMcpToolFeatureEnabled,
    }),
    { mode, context },
  );
  return scopeProseToSurface(text, surfaceToolVocabulary(mode, context)) ?? "";
};
