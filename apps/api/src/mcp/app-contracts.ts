import type * as v from "valibot";

import {
  LOOKUP_CASE_LAW_PROJECTION,
  SEARCH_CASE_LAW_PROJECTION,
} from "../lib/chat/case-law-result-projections";
import { MCP_APPS } from "./apps/manifest";
import type { PresentationApp } from "./apps/manifest";
import type { DEFAULT_MCP_TOOL_DEFINITIONS } from "./static-tool-definitions";

type Tool = (typeof DEFAULT_MCP_TOOL_DEFINITIONS)[number];
type ReadToolName = Extract<Tool, { access: "read" }>["name"];
type AppManifest = {
  directory: string;
  uri: `ui://${string}`;
  linkedTools: readonly Tool["name"][];
} & (
  | { type: "presentation"; callableTools: readonly ReadToolName[] }
  | {
      type: "host-approved-mutation";
      reason: string;
      callableTools: readonly Tool["name"][];
    }
);

// Validate server tool contracts without importing their graph into browser apps.
MCP_APPS satisfies readonly AppManifest[];

export const MCP_APP_OUTPUT_SCHEMAS = {
  search_case_law: SEARCH_CASE_LAW_PROJECTION,
  lookup_case_law: LOOKUP_CASE_LAW_PROJECTION,
} as const satisfies Record<
  PresentationApp["linkedTools"][number],
  v.GenericSchema
>;
