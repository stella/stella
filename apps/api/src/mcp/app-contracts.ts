import type * as v from "valibot";

import { legalResolveResponseSchema } from "@stll/api-contract/legal-resolve";
import { mcpWebHandoffLinkOutputSchema } from "@stll/api-contract/mcp-web-handoff";
import { MCP_APPS } from "@stll/mcp-apps/manifest";
import type { PresentationApp } from "@stll/mcp-apps/manifest";

import { READ_CASE_LAW_CITATIONS_PROJECTION } from "../lib/chat/case-law-citation-projection";
import { SEARCH_CASE_LAW_PROJECTION } from "../lib/chat/case-law-result-projections";
import {
  blocksDecisionOutput,
  openDecisionOutput,
  provisionPreviewOutput,
} from "../lib/chat/decision-reader-projections";
import { READ_PROVISION_HISTORY_PROJECTION } from "../lib/chat/legislation-result-projections";
import type { DEFAULT_MCP_TOOL_DEFINITIONS } from "./static-tool-definitions";
import type { McpToolVisibleTo } from "./tool-visibility";

type Tool = (typeof DEFAULT_MCP_TOOL_DEFINITIONS)[number];
type ReadToolName = Extract<Tool, { access: "read" }>["name"];
type ModelVisibleTool = McpToolVisibleTo<Tool, "model">;
type AppOnlyWriteToolName = Extract<
  Exclude<Extract<Tool, { access: "write" }>, ModelVisibleTool>,
  { access: "write" }
>["name"];
type AppManifest = {
  directory: string;
  uri: `ui://${string}`;
  linkedTools: readonly Tool["name"][];
} & (
  | {
      type: "presentation";
      callableTools: readonly (ReadToolName | AppOnlyWriteToolName)[];
    }
  | {
      type: "host-approved-mutation";
      reason: string;
      callableTools: readonly Tool["name"][];
    }
);

// Validate server tool contracts without importing their graph into browser apps.
MCP_APPS satisfies readonly AppManifest[];

export const MCP_APP_OUTPUT_SCHEMAS = {
  mint_web_handoff: mcpWebHandoffLinkOutputSchema,
  read_provision_history: READ_PROVISION_HISTORY_PROJECTION,
  open_case_law_decision: openDecisionOutput,
  read_case_law_decision_blocks: blocksDecisionOutput,
  preview_cited_provision: provisionPreviewOutput,
  search_case_law: SEARCH_CASE_LAW_PROJECTION,
  resolve_case_law_decision: legalResolveResponseSchema,
  read_case_law_citations: READ_CASE_LAW_CITATIONS_PROJECTION,
} as const satisfies Record<
  PresentationApp["callableTools"][number],
  v.GenericSchema
>;
