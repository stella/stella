import type { JsonSchema } from "@valibot/to-json-schema";

/*
 * Supported draft-07 constructs:
 * - primitive types: string, number, integer, boolean, null
 * - objects via properties/required/additionalProperties/patternProperties
 * - arrays via items/prefixItems/additionalItems
 * - records via additionalProperties
 * - const values
 * - enums as literal unions
 * - direct unions via anyOf / oneOf / type arrays
 * - intersections via allOf
 *
 * Intentionally unsupported:
 * - $ref-driven schemas and recursive definitions without explicit type names
 * - conditional / negation keywords
 * - schema combinations that cannot be rendered as one compact prompt type
 *
 * Unsupported constructs intentionally degrade to `unknown` instead of throwing.
 * This keeps prompt generation total and deterministic while avoiding indirection
 * we do not want the model to chase.
 */

type JsonSchemaDefinition = JsonSchema | boolean;

type RenderContext = {
  depth: number;
  knownReferences: ReadonlyMap<string, string>;
  optionalPropertyUndefined: "include" | "exclude";
};

const INDENT = "  ";
const IDENTIFIER_PATTERN = /^[$A-Z_a-z][$\w]*$/u;

const escapePropertyName = (propertyName: string): string =>
  IDENTIFIER_PATTERN.test(propertyName)
    ? propertyName
    : JSON.stringify(propertyName);

const indentMultilineType = (type: string, depth: number): string =>
  type
    .split("\n")
    .map((line) => `${INDENT.repeat(depth)}${line}`)
    .join("\n");

const isPrimitiveConstValue = (
  value: unknown,
): value is string | number | boolean | null =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

const renderConstType = (value: JsonSchema["const"]): string => {
  if (!isPrimitiveConstValue(value)) {
    return "unknown";
  }

  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "unknown";
  }
  if (typeof value === "boolean") {
    return String(value);
  }

  return "unknown";
};

const renderUnionType = (
  definitions: readonly JsonSchemaDefinition[],
  context: RenderContext,
): string => {
  const renderedParts = definitions.map((definition) =>
    renderSchemaDefinition(definition, context),
  );
  if (renderedParts.some((part) => part === "unknown")) {
    return "unknown";
  }

  return [...new Set(renderedParts)].join(" | ");
};

const renderEnumType = (values: JsonSchema["enum"]): string => {
  if (!values || values.length === 0) {
    return "unknown";
  }

  const literalTypes = values.map((value) => renderConstType(value));
  if (literalTypes.some((type) => type === "unknown")) {
    return "unknown";
  }

  return [...new Set(literalTypes)].join(" | ");
};

const renderPatternPropertyType = (
  patternProperties: JsonSchema["patternProperties"],
  context: RenderContext,
): string | undefined => {
  if (!patternProperties) {
    return undefined;
  }

  const patternTypes = Object.values(patternProperties).map((definition) =>
    renderSchemaDefinition(definition, context),
  );
  const firstType = patternTypes[0];
  if (!firstType) {
    return undefined;
  }

  return patternTypes.every((type) => type === firstType)
    ? firstType
    : "unknown";
};

const renderArrayOfType = (itemType: string): string =>
  /[\n|&]/u.test(itemType) ? `Array<${itemType}>` : `${itemType}[]`;

type RenderTupleTypeProps = {
  additionalItems: JsonSchema["additionalItems"] | JsonSchema["items"];
  context: RenderContext;
  itemDefinitions: JsonSchemaDefinition[];
};

const renderTupleType = ({
  additionalItems,
  context,
  itemDefinitions,
}: RenderTupleTypeProps): string => {
  const itemTypes = itemDefinitions.map((definition) =>
    renderSchemaDefinition(definition, context),
  );

  if (typeof additionalItems === "object" && !Array.isArray(additionalItems)) {
    const restType = renderSchemaDefinition(additionalItems, context);
    return `[${[...itemTypes, `...${renderArrayOfType(restType)}`].join(", ")}]`;
  }

  if (additionalItems === true) {
    return `[${[...itemTypes, "...unknown[]"].join(", ")}]`;
  }

  return `[${itemTypes.join(", ")}]`;
};

const renderArrayType = (
  schema: JsonSchema,
  context: RenderContext,
): string => {
  if (Array.isArray(schema.prefixItems)) {
    return renderTupleType({
      additionalItems: schema.items,
      context,
      itemDefinitions: schema.prefixItems,
    });
  }

  if (Array.isArray(schema.items)) {
    return renderTupleType({
      additionalItems: schema.additionalItems,
      context,
      itemDefinitions: schema.items,
    });
  }

  const itemDefinition = Array.isArray(schema.items)
    ? true
    : (schema.items ?? true);
  const itemType = renderSchemaDefinition(itemDefinition, context);
  return renderArrayOfType(itemType);
};

const renderAdditionalPropertiesType = (
  additionalProperties: JsonSchema["additionalProperties"],
  context: RenderContext,
): string | undefined => {
  if (additionalProperties === false || additionalProperties === undefined) {
    return undefined;
  }

  return renderSchemaDefinition(additionalProperties, context);
};

const renderObjectType = (
  schema: JsonSchema,
  context: RenderContext,
): string => {
  const required = new Set(schema.required);
  const propertyLines = Object.entries(schema.properties ?? {}).map(
    ([propertyName, definition]) => {
      const optionalSuffix = required.has(propertyName) ? "" : "?";
      const propertyType = renderSchemaDefinition(definition, {
        ...context,
        depth: context.depth + 1,
      });

      const optionalValue =
        optionalSuffix && context.optionalPropertyUndefined === "include"
          ? `${propertyType} | undefined`
          : propertyType;
      return `${escapePropertyName(propertyName)}${optionalSuffix}: ${optionalValue};`;
    },
  );

  const additionalPropertiesType = renderAdditionalPropertiesType(
    schema.additionalProperties,
    { ...context, depth: context.depth + 1 },
  );
  const patternPropertiesType = renderPatternPropertyType(
    schema.patternProperties,
    { ...context, depth: context.depth + 1 },
  );
  const indexType = additionalPropertiesType ?? patternPropertiesType;

  if (propertyLines.length === 0 && indexType !== undefined) {
    return `Record<string, ${indexType}>`;
  }

  if (propertyLines.length === 0) {
    return "{}";
  }

  const members = [...propertyLines];
  if (indexType !== undefined) {
    members.push(`[key: string]: ${indexType};`);
  }

  return `{\n${members
    .map((line) => `${INDENT.repeat(context.depth + 1)}${line}`)
    .join("\n")}\n${INDENT.repeat(context.depth)}}`;
};

const renderSchemaType = (
  schema: JsonSchema,
  context: RenderContext,
): string => {
  if (schema.$ref) {
    return context.knownReferences.get(schema.$ref) ?? "unknown";
  }

  if (schema.anyOf) {
    return renderUnionType(schema.anyOf, context);
  }

  if (schema.oneOf) {
    return renderUnionType(schema.oneOf, context);
  }

  if (Array.isArray(schema.type)) {
    return renderUnionType(
      schema.type.map((type) => ({ type })),
      context,
    );
  }

  if (
    schema.if !== undefined ||
    schema.then !== undefined ||
    schema.else !== undefined ||
    schema.not !== undefined
  ) {
    return "unknown";
  }

  if (schema.nullable) {
    return renderUnionType(
      [{ ...schema, nullable: undefined }, { type: "null" }],
      context,
    );
  }

  if (schema.allOf) {
    const parts = schema.allOf.map((definition) =>
      renderSchemaDefinition(definition, context),
    );
    return parts.every((part) => part !== "unknown")
      ? parts.join(" & ")
      : "unknown";
  }

  if (schema.const !== undefined) {
    return renderConstType(schema.const);
  }

  if (schema.enum) {
    return renderEnumType(schema.enum);
  }

  switch (schema.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return renderArrayType(schema, context);
    case "object":
      return renderObjectType(schema, context);
    case undefined:
      break;
    default: {
      if (
        schema.properties !== undefined ||
        schema.additionalProperties !== undefined ||
        schema.patternProperties !== undefined
      ) {
        return renderObjectType(schema, context);
      }
      if (schema.items !== undefined || schema.prefixItems !== undefined) {
        return renderArrayType(schema, context);
      }

      return "unknown";
    }
  }

  if (
    schema.properties !== undefined ||
    schema.additionalProperties !== undefined ||
    schema.patternProperties !== undefined
  ) {
    return renderObjectType(schema, context);
  }
  if (schema.items !== undefined || schema.prefixItems !== undefined) {
    return renderArrayType(schema, context);
  }

  return "unknown";
};

const renderSchemaDefinition = (
  definition: JsonSchemaDefinition | undefined,
  context: RenderContext,
): string => {
  if (definition === undefined) {
    return "unknown";
  }

  if (typeof definition === "boolean") {
    return "unknown";
  }

  return renderSchemaType(definition, context);
};

type JsonSchemaToTypeOptions = {
  knownReferences?: ReadonlyMap<string, string>;
  optionalPropertyUndefined?: "include" | "exclude";
};

export const jsonSchemaToType = (
  schema: JsonSchema,
  {
    knownReferences = new Map(),
    optionalPropertyUndefined = "exclude",
  }: JsonSchemaToTypeOptions = {},
): string =>
  renderSchemaType(schema, {
    depth: 0,
    knownReferences,
    optionalPropertyUndefined,
  });

type JsonSchemaToAsyncFnTypeProps = {
  inputSchema: JsonSchema;
  name: string;
  outputSchema: JsonSchema;
};

export const jsonSchemaToAsyncFnType = ({
  inputSchema,
  name,
  outputSchema,
}: JsonSchemaToAsyncFnTypeProps): string => {
  const inputType = jsonSchemaToType(inputSchema);
  const outputType = jsonSchemaToType(outputSchema);

  return `${name}(input: ${indentMultilineType(inputType, 0)}): Promise<${indentMultilineType(outputType, 0)}>`;
};
