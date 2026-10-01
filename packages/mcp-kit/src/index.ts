/**
 * A framework-free kit for token-lean MCP tool surfaces: compact listed
 * schemas, lazy discovery through `list_capabilities` /
 * `describe_capability` / `invoke_capability`, lenient argument reading, and
 * one `{ error: { code, message, hint, retryable } }` envelope. It imports
 * no transport and nothing product-specific.
 */

export {
  closestNames,
  didYouMean,
  failure,
  KIT_ERROR_CODES,
  success,
  toCallResult,
  toolError,
  validationError,
} from "./envelope";
export { readToolInput, type ReadInput } from "./input";
export {
  advertisedBytes,
  compactSchema,
  hoistRepeatedSchemas,
  type CompactSchemaOptions,
} from "./schema";
export {
  CAPABILITY_TOOL_NAMES,
  createToolSurface,
  type ToolSurface,
  type ToolSurfaceOptions,
} from "./surface";
export type {
  JsonSchema,
  ListedTool,
  ToolAccess,
  ToolCallResult,
  ToolDefinition,
  ToolError,
  ToolInputIssue,
  ToolOutcome,
} from "./types";
