import {
  DOCUMENT_VERSION_UPLOAD_TRANSPORT,
  FILE_COMPARISON_TRANSPORT,
} from "@stll/api-contract";
import { MCP_CAPABILITY_EXECUTORS } from "@stll/api-contract/mcp-capability-executors";
import { MCP_WEB_HANDOFF_TOOL_NAME } from "@stll/api-contract/mcp-web-handoff";

import {
  CASE_LAW_RESULTS_RESOURCE_URI,
  CITATION_GRAPH_RESOURCE_URI,
  DECISION_READER_RESOURCE_URI,
  STATUTE_TIMELINE_RESOURCE_URI,
} from "./resource-uri";

export const MCP_APPS = [
  {
    directory: "document-upload",
    uri: DOCUMENT_VERSION_UPLOAD_TRANSPORT.resourceUri,
    linkedTools: [DOCUMENT_VERSION_UPLOAD_TRANSPORT.pickerToolName],
    type: "host-approved-mutation",
    reason:
      "Existing browser upload workflow; host approves capability writes.",
    callableTools: [MCP_CAPABILITY_EXECUTORS.write],
  },
  {
    directory: "file-comparison",
    uri: FILE_COMPARISON_TRANSPORT.resourceUri,
    linkedTools: [FILE_COMPARISON_TRANSPORT.pickerToolName],
    type: "host-approved-mutation",
    reason:
      "Existing comparison upload workflow; host approves file reservation writes.",
    callableTools: [FILE_COMPARISON_TRANSPORT.prepareToolName],
  },
  {
    directory: "case-law-results",
    uri: CASE_LAW_RESULTS_RESOURCE_URI,
    linkedTools: ["search_case_law", "resolve_case_law_decision"],
    type: "presentation",
    callableTools: [
      MCP_WEB_HANDOFF_TOOL_NAME,
      "search_case_law",
      "resolve_case_law_decision",
      "open_case_law_decision",
      "read_case_law_decision_blocks",
      "preview_cited_provision",
    ],
  },
  {
    directory: "decision-reader",
    uri: DECISION_READER_RESOURCE_URI,
    linkedTools: ["open_case_law_decision"],
    type: "presentation",
    callableTools: [
      MCP_WEB_HANDOFF_TOOL_NAME,
      "open_case_law_decision",
      "read_case_law_decision_blocks",
      "preview_cited_provision",
    ],
  },
  {
    directory: "citation-graph",
    uri: CITATION_GRAPH_RESOURCE_URI,
    linkedTools: ["read_case_law_citations"],
    type: "presentation",
    callableTools: [
      MCP_WEB_HANDOFF_TOOL_NAME,
      "read_case_law_citations",
      "open_case_law_decision",
    ],
  },
  {
    directory: "statute-timeline",
    uri: STATUTE_TIMELINE_RESOURCE_URI,
    linkedTools: ["read_provision_history"],
    type: "presentation",
    callableTools: [MCP_WEB_HANDOFF_TOOL_NAME, "read_provision_history"],
  },
] as const;

export type McpAppDirectory = (typeof MCP_APPS)[number]["directory"];

export const DOCUMENT_UPLOAD_APP = MCP_APPS[0];
export const FILE_COMPARISON_APP = MCP_APPS[1];
export const CASE_LAW_RESULTS_APP = MCP_APPS[2];
export const DECISION_READER_APP = MCP_APPS[3];
export const CITATION_GRAPH_APP = MCP_APPS[4];
export type PresentationApp = Extract<
  (typeof MCP_APPS)[number],
  { type: "presentation" }
>;

// Every presentation app opens links through the shared handoff refresh, so
// its host must allow the handoff tool; a manifest without it fails to build.
type LacksHandoffTool<App> = App extends {
  callableTools: readonly (infer Tool)[];
}
  ? typeof MCP_WEB_HANDOFF_TOOL_NAME extends Tool
    ? never
    : App
  : never;
true satisfies [LacksHandoffTool<PresentationApp>] extends [never]
  ? true
  : false;

export const STATUTE_TIMELINE_APP = MCP_APPS[5];
