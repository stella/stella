import type { JsonSchema } from "./route-types.js";
import { compileSchemaPattern } from "./schema-pattern.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const propertiesOf = (schema: JsonSchema): Record<string, JsonSchema> => {
  const properties = schema["properties"];
  if (!isRecord(properties)) {
    return {};
  }
  const result: Record<string, JsonSchema> = {};
  for (const [name, child] of Object.entries(properties)) {
    if (isRecord(child)) {
      result[name] = child;
    }
  }
  return result;
};

const requiredOf = (schema: JsonSchema): ReadonlySet<string> => {
  const required = schema["required"];
  if (!Array.isArray(required)) {
    return new Set();
  }
  return new Set(
    required.filter((name): name is string => typeof name === "string"),
  );
};

const schemaTypes = (schema: JsonSchema): readonly string[] => {
  const type = schema["type"];
  if (Array.isArray(type)) {
    return type.filter((entry): entry is string => typeof entry === "string");
  }
  return typeof type === "string" ? [type] : [];
};

const descriptionOf = (schema: JsonSchema): string | undefined => {
  const description = schema["description"];
  if (typeof description !== "string") {
    return undefined;
  }
  const normalized = description.replace(/\s+/gu, " ").trim();
  return normalized.length === 0 ? undefined : normalized;
};

const anyOf = (schema: JsonSchema): readonly JsonSchema[] => {
  const variants = schema["anyOf"];
  if (!Array.isArray(variants)) {
    return [];
  }
  return variants.filter(isRecord);
};

const mapValueSchema = (schema: JsonSchema): JsonSchema | undefined => {
  const additional = schema["additionalProperties"];
  if (additional === true) {
    return {};
  }
  if (isRecord(additional)) {
    return additional;
  }
  const patterns = schema["patternProperties"];
  if (!isRecord(patterns)) {
    return undefined;
  }
  const first = Object.values(patterns).find(isRecord);
  return first;
};

const scalarTypeLabel = (schema: JsonSchema): string => {
  const constant = schema["const"];
  if (
    typeof constant === "string" ||
    typeof constant === "number" ||
    typeof constant === "boolean"
  ) {
    return JSON.stringify(constant);
  }
  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return enumValues.map((value) => JSON.stringify(value)).join(" | ");
  }
  if (schema["type"] === "RegExp" || typeof schema["source"] === "string") {
    return "string";
  }
  const types = schemaTypes(schema);
  if (types.length > 0) {
    return types.join(" | ");
  }
  return "any JSON value";
};

const variantLabel = (schema: JsonSchema, index: number): string => {
  for (const [name, child] of Object.entries(propertiesOf(schema))) {
    if (child["const"] !== undefined) {
      return `variant ${index + 1}, ${name} = ${JSON.stringify(child["const"])}`;
    }
  }
  return `variant ${index + 1}`;
};

const lineFor = ({
  path,
  type,
  required,
  description,
  indent,
}: {
  path: string;
  type: string;
  required: boolean;
  description: string | undefined;
  indent: number;
}): string => {
  const suffix = description === undefined ? "" : ` — ${description}`;
  return `${"  ".repeat(indent)}${path}  ${type}  ${required ? "required" : "optional"}${suffix}`;
};

const renderSchema = ({
  path,
  schema,
  required,
  indent,
  lines,
}: {
  path: string;
  schema: JsonSchema;
  required: boolean;
  indent: number;
  lines: string[];
}): void => {
  const variants = anyOf(schema);
  if (variants.length > 0) {
    lines.push(
      lineFor({
        path,
        type: `one of ${variants.length} variants`,
        required,
        description: descriptionOf(schema),
        indent,
      }),
    );
    for (const [index, variant] of variants.entries()) {
      const label = variantLabel(variant, index);
      lines.push(`${"  ".repeat(indent + 1)}${label}:`);
      renderSchema({
        path,
        schema: variant,
        required,
        indent: indent + 2,
        lines,
      });
    }
    return;
  }

  const types = schemaTypes(schema);
  if (types.includes("array")) {
    const items = schema["items"];
    const itemSchema = isRecord(items) ? items : undefined;
    lines.push(
      lineFor({
        path,
        type: `array<${itemSchema === undefined ? "any JSON value" : scalarTypeLabel(itemSchema)}>`,
        required,
        description: descriptionOf(schema),
        indent,
      }),
    );
    if (
      itemSchema !== undefined &&
      Object.keys(propertiesOf(itemSchema)).length > 0
    ) {
      renderObjectChildren({
        path: `${path}[]`,
        schema: itemSchema,
        indent: indent + 1,
        lines,
      });
    }
    return;
  }

  const properties = propertiesOf(schema);
  if (types.includes("object") || Object.keys(properties).length > 0) {
    const mapValue = mapValueSchema(schema);
    const freeMap =
      mapValue !== undefined && Object.keys(properties).length === 0;
    lines.push(
      lineFor({
        path: freeMap ? `${path}.<key>` : path,
        type: freeMap ? scalarTypeLabel(mapValue) : "object",
        required,
        description: descriptionOf(schema),
        indent,
      }),
    );
    if (!freeMap) {
      renderObjectChildren({ path, schema, indent: indent + 1, lines });
    }
    return;
  }

  lines.push(
    lineFor({
      path,
      type: scalarTypeLabel(schema),
      required,
      description: descriptionOf(schema),
      indent,
    }),
  );
};

const renderObjectChildren = ({
  path,
  schema,
  indent,
  lines,
}: {
  path: string;
  schema: JsonSchema;
  indent: number;
  lines: string[];
}): void => {
  const required = requiredOf(schema);
  for (const [name, child] of Object.entries(propertiesOf(schema))) {
    renderSchema({
      path: `${path}.${name}`,
      schema: child,
      required: required.has(name),
      indent,
      lines,
    });
  }
};

const schemaAtPath = (
  schema: JsonSchema,
  path: string,
): JsonSchema | undefined => {
  let current = schema;
  for (const segment of path.split(".")) {
    const child = propertiesOf(current)[segment];
    if (child === undefined) {
      return undefined;
    }
    current = child;
  }
  return current;
};

const pathRequired = (schema: JsonSchema, path: string): boolean => {
  const segments = path.split(".");
  let parent = schema;
  for (const [index, segment] of segments.entries()) {
    if (index === segments.length - 1) {
      return requiredOf(parent).has(segment);
    }
    const child = propertiesOf(parent)[segment];
    if (child === undefined) {
      return false;
    }
    parent = child;
  }
  return false;
};

const characterForClass = (characterClass: string): string | undefined => {
  if (characterClass.includes("0-9")) {
    return "0";
  }
  if (characterClass.includes("A-Z")) {
    return "A";
  }
  if (characterClass.includes("a-z")) {
    return "a";
  }
  return characterClass.at(0);
};

const patternExample = (pattern: string): string | undefined => {
  if (!pattern.startsWith("^") || !pattern.endsWith("$")) {
    return undefined;
  }

  const body = pattern.slice(1, -1);
  const tokens: string[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === undefined) {
      return undefined;
    }

    let token: string;
    if (character === "[") {
      const end = body.indexOf("]", index + 1);
      if (end === -1) {
        return undefined;
      }
      const classCharacter = characterForClass(body.slice(index + 1, end));
      if (classCharacter === undefined) {
        return undefined;
      }
      token = classCharacter;
      index = end;
    } else if (character === "\\") {
      const escaped = body[index + 1];
      if (escaped === undefined) {
        return undefined;
      }
      token = escaped === "d" ? "0" : escaped;
      index += 1;
    } else if ("().|".includes(character)) {
      return undefined;
    } else {
      token = character;
    }

    const remainder = body.slice(index + 1);
    const exact = /^\{(\d+)\}/u.exec(remainder);
    if (exact !== null) {
      tokens.push(token.repeat(Number(exact[1])));
      index += exact[0].length;
      continue;
    }
    if (remainder.startsWith("+")) {
      tokens.push(token);
      index += 1;
      continue;
    }
    if (remainder.startsWith("?")) {
      tokens.push(token);
      index += 1;
      continue;
    }
    if (remainder.startsWith("*")) {
      index += 1;
      continue;
    }
    tokens.push(token);
  }

  const example = tokens.join("");
  const compiled = compileSchemaPattern(pattern);
  if (compiled.status === "invalid") {
    return undefined;
  }
  return compiled.regex.test(example) ? example : undefined;
};

const stringExample = (schema: JsonSchema): string => {
  const format = schema["format"];
  if (format === "date") {
    return "2026-01-01";
  }
  if (format === "date-time") {
    return "2026-01-01T00:00:00.000Z";
  }
  if (format === "integer") {
    const minimum = schema["minimum"];
    return String(typeof minimum === "number" ? minimum : 0);
  }
  const pattern = schema["pattern"];
  if (typeof pattern === "string" && pattern.includes("[0-9a-fA-F]{8}")) {
    return "00000000-0000-4000-8000-000000000000";
  }
  if (typeof pattern === "string") {
    const example = patternExample(pattern);
    if (example !== undefined) {
      return example;
    }
  }
  const source = schema["source"];
  if (source === "^[0-9a-f]{64}$") {
    return "0".repeat(64);
  }
  const minLength = schema["minLength"];
  const maxLength = schema["maxLength"];
  const preferredLength =
    typeof minLength === "number" ? Math.max(1, minLength) : 5;
  const length =
    typeof maxLength === "number"
      ? Math.min(preferredLength, maxLength)
      : preferredLength;
  return "x".repeat(length);
};

const exampleFor = (schema: JsonSchema): unknown => {
  const constant = schema["const"];
  if (constant !== undefined) {
    return constant;
  }
  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return enumValues.at(0);
  }
  const variants = anyOf(schema);
  if (variants.length > 0) {
    const variant = variants.at(0) ?? {};
    return exampleFor({ ...schema, ...variant, anyOf: undefined });
  }
  const types = schemaTypes(schema);
  const defaultValue = schema["default"];
  if (
    defaultValue !== undefined &&
    ((types.includes("string") && typeof defaultValue === "string") ||
      (types.includes("number") && typeof defaultValue === "number") ||
      (types.includes("integer") &&
        typeof defaultValue === "number" &&
        Number.isInteger(defaultValue)) ||
      (types.includes("boolean") && typeof defaultValue === "boolean"))
  ) {
    return defaultValue;
  }
  if (
    types.includes("object") ||
    Object.keys(propertiesOf(schema)).length > 0
  ) {
    const result: Record<string, unknown> = {};
    for (const name of requiredOf(schema)) {
      const child = propertiesOf(schema)[name];
      if (child !== undefined) {
        result[name] = exampleFor(child);
      }
    }
    const mapValue = mapValueSchema(schema);
    if (mapValue !== undefined) {
      result["key"] = exampleFor(mapValue);
    }
    return result;
  }
  if (types.includes("array")) {
    const items = schema["items"];
    const minimum = schema["minItems"];
    const count = typeof minimum === "number" ? Math.max(1, minimum) : 1;
    const value = isRecord(items) ? exampleFor(items) : "value";
    return Array.from({ length: count }, () => value);
  }
  if (types.includes("integer") || types.includes("number")) {
    const minimum = schema["minimum"];
    return typeof minimum === "number" ? minimum : 0;
  }
  if (types.includes("boolean")) {
    return false;
  }
  if (types.includes("null")) {
    return null;
  }
  if (types.length === 0 && typeof schema["source"] !== "string") {
    return "value";
  }
  return stringExample(schema);
};

const setExamplePath = (
  schema: JsonSchema,
  target: Record<string, unknown>,
  path: string,
): void => {
  const segments = path.split(".");
  let current = target;
  let currentSchema = schema;
  for (const segment of segments) {
    const childSchema = propertiesOf(currentSchema)[segment];
    if (childSchema === undefined) {
      return;
    }
    const existing = current[segment];
    if (isRecord(existing)) {
      current = existing;
      currentSchema = childSchema;
      continue;
    }
    const example = exampleFor(childSchema);
    current[segment] = example;
    if (isRecord(example)) {
      current = example;
      currentSchema = childSchema;
    }
  }
};

export type InputContractHelp = {
  fields: readonly string[];
  example: Record<string, unknown>;
};

/** Quote a generated JSON example as one POSIX-shell argument. */
export const formatInputExample = (example: Record<string, unknown>): string =>
  `--input '${JSON.stringify(example).replaceAll("'", `'\\''`)}'`;

/**
 * Render the schema subtrees that cannot be expressed as scalar CLI flags and
 * produce a deterministic, schema-derived full-input example. Both artifacts
 * come from the validation schema, so help cannot drift into a hand-authored
 * second contract.
 */
export const buildInputContractHelp = ({
  schema,
  inputOnly,
  requiredPaths = [],
}: {
  schema: JsonSchema;
  inputOnly: readonly string[];
  requiredPaths?: readonly string[];
}): InputContractHelp | undefined => {
  if (inputOnly.length === 0) {
    return undefined;
  }

  const fields: string[] = [];
  for (const path of inputOnly) {
    const fieldSchema = schemaAtPath(schema, path);
    if (fieldSchema === undefined) {
      continue;
    }
    renderSchema({
      path,
      schema: fieldSchema,
      required: pathRequired(schema, path),
      indent: 0,
      lines: fields,
    });
  }

  const rootExample = exampleFor(schema);
  const example = isRecord(rootExample) ? rootExample : {};
  for (const path of [...inputOnly, ...requiredPaths]) {
    setExamplePath(schema, example, path);
  }
  return { fields, example };
};
