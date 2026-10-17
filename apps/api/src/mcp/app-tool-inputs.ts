import type { PresentationApp } from "@stll/mcp-apps/manifest";

import { readCaseLawCitationsArgsSchema } from "./case-law-citations-input";
import { searchCaseLawTexts } from "./case-law-search-guidance";
import {
  SEARCH_CASE_LAW_INPUT_NORMALIZATION,
  searchCaseLawArgsSchema,
} from "./case-law-search-input";
import {
  openDecisionArgs,
  previewProvisionArgs,
  readDecisionBlocksArgs,
} from "./decision-reader-contract";
import {
  LEGAL_RESOLVE_INPUT_NORMALIZATION,
  resolveDecisionArgsSchema,
} from "./legal-resolve-input";
import {
  READ_PROVISION_HISTORY_INPUT_NORMALIZATION,
  readProvisionHistoryArgsSchema,
} from "./legislation-input";
import { deriveValibotMcpInputSchema } from "./valibot-tool-definition";

type AppToolName = PresentationApp["callableTools"][number];

/**
 * The input contracts of the tools presentation apps call, read from the same
 * schemas the tool definitions declare. Unlike the tool registry, these load
 * no handlers, environment or services.
 */
const MCP_APP_TOOL_INPUTS = {
  // Browser contracts carry no descriptions, so the guidance mode is moot.
  search_case_law: {
    inputSchema: searchCaseLawArgsSchema(searchCaseLawTexts("off")),
    inputNormalization: SEARCH_CASE_LAW_INPUT_NORMALIZATION,
  },
  resolve_case_law_decision: {
    inputSchema: resolveDecisionArgsSchema,
    inputNormalization: LEGAL_RESOLVE_INPUT_NORMALIZATION,
  },
  open_case_law_decision: { inputSchema: openDecisionArgs },
  read_case_law_citations: { inputSchema: readCaseLawCitationsArgsSchema },
  read_case_law_decision_blocks: { inputSchema: readDecisionBlocksArgs },
  preview_cited_provision: { inputSchema: previewProvisionArgs },
  read_provision_history: {
    inputSchema: readProvisionHistoryArgsSchema,
    inputNormalization: READ_PROVISION_HISTORY_INPUT_NORMALIZATION,
  },
} satisfies Record<
  AppToolName,
  Parameters<typeof deriveValibotMcpInputSchema>[0]
>;

/** The JSON Schema each app-callable tool advertises for its input. */
export const mcpAppToolInputSchema = (name: AppToolName) =>
  deriveValibotMcpInputSchema(MCP_APP_TOOL_INPUTS[name]);
