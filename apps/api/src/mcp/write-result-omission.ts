import type { CallToolResult } from "@modelcontextprotocol/server";
import * as v from "valibot";

import type {
  McpToolAccess,
  McpToolOutputSchema,
  RuntimeMcpToolOutputContract,
} from "@/api/mcp/tool-types";
import { deriveMcpOutputSchema } from "@/api/mcp/valibot-tool-definition";

/**
 * The structured result a write tool answers with when the action ran but its
 * result exceeds the configured response byte limit: the action is applied,
 * the result is left out, and the caller inspects the outcome with a read tool
 * instead of repeating the action.
 */
export const MCP_OMITTED_WRITE_RESULT = {
  applied: true,
  resultOmitted: true,
  reason: "result_too_large",
} as const;

const OMITTED_WRITE_RESULT_ENTRIES = {
  applied: v.literal(MCP_OMITTED_WRITE_RESULT.applied),
  resultOmitted: v.literal(MCP_OMITTED_WRITE_RESULT.resultOmitted),
  reason: v.literal(MCP_OMITTED_WRITE_RESULT.reason),
} as const satisfies Record<
  keyof typeof MCP_OMITTED_WRITE_RESULT,
  v.GenericSchema
>;

const OMITTED_WRITE_RESULT_SOURCE = v.strictObject(
  OMITTED_WRITE_RESULT_ENTRIES,
);

/** The `tools/call` result carrying {@link MCP_OMITTED_WRITE_RESULT}. */
export const omittedWriteToolResult = (): CallToolResult => ({
  isError: false,
  content: [
    {
      type: "text",
      text: "Action applied. The result was too large and was omitted. Do not repeat the action; use a read tool to inspect its outcome.",
    },
  ],
  structuredContent: { ...MCP_OMITTED_WRITE_RESULT },
});

/**
 * Compose before conversion so the canonical converter owns references and
 * their definitions at the final document root, including recursive outputs.
 */
const withWriteResultOmission = (schema: v.GenericSchema) =>
  v.union([schema, OMITTED_WRITE_RESULT_SOURCE]);

type AdvertisedMcpOutputSchemaOptions = {
  contract: Pick<
    RuntimeMcpToolOutputContract,
    "outputSchema" | "outputSchemaSource"
  >;
  access: McpToolAccess;
  compaction?: "equivalent" | "none";
};

/**
 * The schema a tool advertises for its result: a write tool's own output or
 * its omitted result, a read tool's own output. Reads over the byte limit are
 * refused with an error instead, so they carry no omission marker.
 */
export const advertisedMcpOutputSchema = ({
  contract,
  access,
  compaction = "equivalent",
}: AdvertisedMcpOutputSchemaOptions): McpToolOutputSchema => {
  if (access === "read") {
    return contract.outputSchema;
  }
  const source = withWriteResultOmission(contract.outputSchemaSource);
  const schema = deriveMcpOutputSchema(source, {
    customSchemaProjection: "chat-string-ids",
    compaction,
    objectUnionDisposition: "preserve",
  });
  // The 2025 wire requires an object root, including an object-only union.
  return { ...schema, type: "object" };
};
