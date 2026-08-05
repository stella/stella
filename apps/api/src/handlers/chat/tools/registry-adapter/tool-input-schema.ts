import type { JSONSchema } from "@tanstack/ai";

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
type JsonSchemaProperties = NonNullable<JsonSchema["properties"]>;
type JsonSchemaProperty = JsonSchemaProperties[string];

const toPropertySchema = (property: JsonSchemaProperty): JSONSchema => {
  // JSON Schema allows a bare `true`/`false` as a whole schema, which the
  // target interface cannot express. An empty schema constrains nothing, which
  // is exactly what `true` means; `false` does not appear in a tool definition.
  if (typeof property === "boolean") {
    return {};
  }

  // Assigned rather than spread: under `exactOptionalPropertyTypes` a
  // conditional spread widens each optional key with `undefined`, which the
  // target's exact optionals reject.
  const converted: JSONSchema = {};
  if (property.type !== undefined) {
    // SAFETY: the SDK models JSON Schema type names as an enum whose `ValueOf`
    // widens to String prototype members, so the value has no structural
    // narrowing to `string | string[]`. JSON Schema fixes these names to
    // strings ("object", "string", ...), and the projection is read only to
    // render prompt stubs.
    converted.type = property.type as string | string[];
  }
  if (property.description !== undefined) {
    converted.description = property.description;
  }
  if (property.enum !== undefined) {
    converted.enum = [...property.enum];
  }
  if (property.items !== undefined && !Array.isArray(property.items)) {
    converted.items = toPropertySchema(property.items);
  }
  if (property.properties !== undefined) {
    converted.properties = toProperties(property.properties);
  }
  if (property.required !== undefined) {
    converted.required = [...property.required];
  }
  return converted;
};

const toProperties = (
  properties: JsonSchemaProperties,
): Record<string, JSONSchema> =>
  Object.fromEntries(
    Object.entries(properties).map(([name, property]) => [
      name,
      toPropertySchema(property),
    ]),
  );

export const toToolInputSchema = (schema: JsonSchema): JSONSchema => ({
  // Registry inputs are object schemas by construction. The SDK's schema type
  // widens `type` to the whole JSON Schema union (including arrays of types),
  // so pin the one value this boundary can carry.
  type: "object",
  ...(schema.properties === undefined
    ? {}
    : { properties: toProperties(schema.properties) }),
  // The SDK's schema type allows a readonly `required`; the target wants a
  // mutable array, so copy rather than share the definition's own array.
  ...(schema.required === undefined ? {} : { required: [...schema.required] }),
});
