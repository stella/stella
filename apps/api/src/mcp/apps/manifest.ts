import {
  DOCUMENT_VERSION_UPLOAD_TRANSPORT,
  FILE_COMPARISON_TRANSPORT,
} from "@stll/api-contract";
import { MCP_CAPABILITY_EXECUTORS } from "@stll/api-contract/mcp-capability-executors";

import {
  CASE_LAW_RESULTS_RESOURCE_URI,
  DECISION_READER_RESOURCE_URI,
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
      "open_case_law_decision",
      "read_case_law_decision_blocks",
      "preview_cited_provision",
    ],
  },
] as const;

export const CASE_LAW_RESULTS_APP = MCP_APPS[2];
export const DECISION_READER_APP = MCP_APPS[3];
export type PresentationApp = Extract<
  (typeof MCP_APPS)[number],
  { type: "presentation" }
>;
