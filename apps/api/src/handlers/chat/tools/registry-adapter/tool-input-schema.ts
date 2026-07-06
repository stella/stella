import type { SchemaInput } from "@tanstack/ai";

import type { JsonSchema } from "@/api/mcp/tool-types";

/**
 * The MCP registry stores each tool's input as a plain JSON Schema object
 * (`McpTool["inputSchema"]`). code-mode's `toolDefinition` types `inputSchema`
 * as `SchemaInput`, whose plain-JSON-Schema branch is a nominally distinct
 * interface, so the two JSON-Schema *types* do not unify structurally even
 * though the value is a valid JSON Schema. Projected inputs are only read by
 * code-mode's stub generator for the system prompt; the registry handler still
 * validates its args with its own Valibot schema, so no validation is lost.
 * Shared by the read projection (`chat-code-mode.ts`) and the write projection
 * (`registry-write-tools.ts`) so this stays the single such boundary cast.
 */
export const toToolInputSchema = (schema: JsonSchema): SchemaInput =>
  // SAFETY: JSON-Schema-to-SchemaInput boundary; see the note above.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- see note above
  schema as unknown as SchemaInput;
