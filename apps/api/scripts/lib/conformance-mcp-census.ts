import { panic } from "better-result";

import { compareCodeUnit } from "@stll/collation";

import { DYNAMIC_TOOL_FAMILY_POLICIES } from "../../src/mcp/gateway/dynamic-tool-policy";
import { MCP_MODES } from "../../src/mcp/resource-policy-contract";
import {
  getStaticMcpToolOutputContract,
  listStaticMcpToolDefinitions,
} from "../../src/mcp/static-tool-definitions";
import { deriveCapabilityId } from "./capability-catalog";
import type { ParsedExposure } from "./enumerate-safe-handlers";

export type ConformanceEndpoint = {
  id: string;
  config: Readonly<Record<string, unknown>>;
  exposure: ParsedExposure;
};

export type McpConformanceRow = {
  kind: "mcp" | "capability";
  id: string;
  mode?: (typeof MCP_MODES)[number];
  name?: string;
  surface: "static" | "dynamic-template" | "capability";
  owner: "stella" | "upstream";
  schema: unknown;
  schemaSource: string;
  schemaExemption?: "upstream-text-relay";
  handlerEndpoint?: string;
};

/** Registry-owned schemas only; dynamic family rows represent templates, not served tool names. */
export const collectMcpConformanceRows = (
  endpoints: readonly ConformanceEndpoint[],
): McpConformanceRow[] => {
  const rows: McpConformanceRow[] = [];
  for (const mode of MCP_MODES) {
    for (const tool of listStaticMcpToolDefinitions(mode)) {
      const contract = getStaticMcpToolOutputContract(tool.name, mode);
      rows.push({
        kind: "mcp",
        id: `${mode}:${tool.name}`,
        mode,
        name: tool.name,
        surface: "static",
        owner: "stella",
        schema: contract?.outputSchema,
        schemaSource:
          "apps/api/src/mcp/static-tool-definitions.ts#getStaticMcpToolOutputContract",
      });
    }
  }
  for (const [family, policy] of Object.entries(DYNAMIC_TOOL_FAMILY_POLICIES)) {
    const shared = {
      kind: "mcp",
      id: `dynamic-template:${family}`,
      name: family,
      surface: "dynamic-template",
      schemaSource:
        "apps/api/src/mcp/gateway/dynamic-tool-policy.ts#DYNAMIC_TOOL_FAMILY_POLICIES",
    } as const;
    switch (policy.owner) {
      case "stella":
        rows.push({
          ...shared,
          owner: policy.owner,
          schema: policy.output.outputSchema,
        });
        break;
      case "upstream":
        rows.push({
          ...shared,
          owner: policy.owner,
          schema: undefined,
          schemaExemption: "upstream-text-relay",
        });
        break;
      default: {
        policy satisfies never;
        panic("Unhandled dynamic tool owner");
      }
    }
  }
  for (const endpoint of endpoints) {
    switch (endpoint.exposure.type) {
      case "internal":
      case "pending":
      case "invalid":
        continue;
      case "tool":
      case "covered":
      case "capability": {
        const separator = endpoint.id.lastIndexOf("#");
        const file =
          separator === -1 ? endpoint.id : endpoint.id.slice(0, separator);
        const exportName =
          separator === -1 ? undefined : endpoint.id.slice(separator + 1);
        rows.push({
          kind: "capability",
          id: deriveCapabilityId({ file, exportName }),
          surface: "capability",
          owner: "stella",
          schema: endpoint.config["response"],
          schemaSource: `${endpoint.id}#config.response`,
          handlerEndpoint: endpoint.id,
        });
        break;
      }
      default: {
        endpoint.exposure satisfies never;
        panic("Unhandled capability exposure");
      }
    }
  }
  return rows.toSorted((left, right) => {
    const leftKey = `${left.kind}:${left.id}`;
    const rightKey = `${right.kind}:${right.id}`;
    return compareCodeUnit(leftKey, rightKey);
  });
};
