import {
  DOCUMENT_VERSION_UPLOAD_TRANSPORT,
  FILE_COMPARISON_TRANSPORT,
} from "@stll/api-contract";
import { MCP_CAPABILITY_EXECUTORS } from "@stll/api-contract/mcp-capability-executors";

import { CASE_LAW_RESULTS_RESOURCE_URI } from "./resource-uri";

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
    linkedTools: ["search_case_law", "lookup_case_law"],
    type: "presentation",
    callableTools: ["search_case_law", "lookup_case_law"],
  },
] as const;

export const CASE_LAW_RESULTS_APP = MCP_APPS[2];
export type PresentationApp = Extract<
  (typeof MCP_APPS)[number],
  { type: "presentation" }
>;
