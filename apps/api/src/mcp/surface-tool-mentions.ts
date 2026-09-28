import type { McpMode } from "@/api/mcp/constants";
import {
  listStaticMcpToolDefinitions,
  REGISTERED_MCP_TOOL_NAMES,
} from "@/api/mcp/static-tool-definitions";
import {
  scopeProseToSurface,
  unlistedToolNames,
  type ToolVocabulary,
} from "@/api/mcp/tool-mentions";
import type { InternalToolResult } from "@/api/mcp/tool-types";

const toVocabulary = (mode: McpMode): ToolVocabulary => ({
  registered: REGISTERED_MCP_TOOL_NAMES,
  listed: new Set(listStaticMcpToolDefinitions(mode).map(({ name }) => name)),
});

const SURFACE_TOOL_VOCABULARY = {
  default: toVocabulary("default"),
  documents: toVocabulary("documents"),
  anonymized: toVocabulary("anonymized"),
  law: toVocabulary("law"),
} as const satisfies Record<McpMode, ToolVocabulary>;

/** The registry-wide names and the ones one surface lists, read off its registry. */
export const surfaceToolVocabulary = (mode: McpMode): ToolVocabulary =>
  SURFACE_TOOL_VOCABULARY[mode];

/** Registered tools the text names that the surface does not list. */
export const unlistedToolNamesIn = (
  text: string,
  mode: McpMode,
): readonly string[] => unlistedToolNames(text, surfaceToolVocabulary(mode));

/**
 * A hint as the serving surface should read it. Handlers never see the mode,
 * so a shared hint (the report-a-bug step on an internal failure) is written
 * once, one step per sentence, and scoped here at the transport boundary.
 */
export const scopeHintToSurface = (
  hint: string,
  mode: McpMode,
): string | undefined => scopeProseToSurface(hint, surfaceToolVocabulary(mode));

/**
 * {@link scopeHintToSurface} applied to a finished tool result. Success
 * payloads and plain-text errors pass through untouched; only the structured
 * envelope's `hint`, the field that tells a model what to call next, is
 * scoped. A hint with no surviving sentence is omitted: no hint is better than
 * one that points at a tool the caller cannot reach.
 */
export const scopeToolResultToSurface = <TData>(
  result: InternalToolResult<TData>,
  mode: McpMode,
): InternalToolResult<TData> => {
  if (result.status === "success" || result.error.type !== "structured") {
    return result;
  }
  const { hint, ...error } = result.error;
  if (hint === undefined) {
    return result;
  }
  const scoped = scopeHintToSurface(hint, mode);
  if (scoped === hint) {
    return result;
  }
  return {
    status: "error",
    error: scoped === undefined ? error : { ...error, hint: scoped },
  };
};
