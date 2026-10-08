import type { CallToolResult } from "@modelcontextprotocol/server";
import { Result } from "better-result";
import * as v from "valibot";

import type { McpMode } from "@/api/mcp/constants";
import { getMcpWwwAuthenticateHeader } from "@/api/mcp/metadata";

/** Tool-result `_meta` key hosts read as a per-call authorization challenge. */
const MCP_TOOL_AUTH_CHALLENGE_META_KEY = "mcp/www_authenticate";

const missingScopeEnvelopeSchema = v.object({
  error: v.looseObject({ code: v.literal("missing_scope") }),
});

const isMissingScopeText = (text: string): boolean => {
  const parsed = Result.try((): unknown => JSON.parse(text));
  return Result.isOk(parsed) && v.is(missingScopeEnvelopeSchema, parsed.value);
};

/**
 * Attaches an `insufficient_scope` challenge to a `missing_scope` tool error,
 * so a host that reads tool-level challenges can offer to reconnect in place
 * instead of leaving the user to find the app's settings.
 * The challenge points at the serving surface's protected-resource metadata,
 * the same document the transport's 401 challenge names. Every other result
 * passes through unchanged.
 */
export const withToolAuthChallenge = (
  result: CallToolResult,
  mode: McpMode,
): CallToolResult => {
  if (
    result.isError !== true ||
    !result.content.some(
      (block) => block.type === "text" && isMissingScopeText(block.text),
    )
  ) {
    return result;
  }
  return {
    ...result,
    _meta: {
      ...result._meta,
      [MCP_TOOL_AUTH_CHALLENGE_META_KEY]: [
        getMcpWwwAuthenticateHeader({ error: "insufficient_scope", mode }),
      ],
    },
  };
};
