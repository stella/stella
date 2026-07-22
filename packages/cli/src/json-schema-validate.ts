// Interpreted JSON-Schema validator for the `--input` escape hatch (spec 051
// S5.5 rule 1): it walks the schema and the data recursively, with NO
// `Function`/`eval`/dynamic code generation. Scoped to exactly the shapes the
// MCP prop builders emit (string, nullable-string, integer/number with
// min/max, enum, boolean, array + items, object + properties, free map). A
// hand-rolled walker is simpler and lighter than a general-purpose library for
// this closed shape set, and it structurally cannot run generated code.

import { compileSchemaPattern } from "./schema-pattern.js";

type JsonSchema = Record<string, unknown>;

/** A validation outcome: valid, or the failing JSON path plus a message. */
export type ValidationResult =
  | { valid: true }
  | { valid: false; path: string; message: string };

const ok: ValidationResult = { valid: true };

const fail = (path: string, message: string): ValidationResult => ({
  valid: false,
  path: path === "" ? "(root)" : path,
  message,
});

const schemaTypes = (schema: JsonSchema): readonly string[] => {
  const rawType = schema["type"];
  if (Array.isArray(rawType)) {
    return rawType.filter((t): t is string => typeof t === "string");
  }
  return typeof rawType === "string" ? [rawType] : [];
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const enumValues = (schema: JsonSchema): readonly unknown[] | undefined =>
  Array.isArray(schema["enum"]) ? schema["enum"] : undefined;

const validateString = (
  schema: JsonSchema,
  value: string,
  path: string,
): ValidationResult => {
  const minLength = schema["minLength"];
  if (typeof minLength === "number" && value.length < minLength) {
    return fail(path, `string shorter than minLength ${minLength}`);
  }
  const maxLength = schema["maxLength"];
  if (typeof maxLength === "number" && value.length > maxLength) {
    return fail(path, `string longer than maxLength ${maxLength}`);
  }
  const pattern = schema["pattern"];
  if (typeof pattern === "string") {
    const compiled = compileSchemaPattern(pattern);
    if (compiled.status === "invalid") {
      return fail(path, "schema contains an invalid string pattern");
    }
    if (!compiled.regex.test(value)) {
      return fail(path, `string does not match pattern ${pattern}`);
    }
  }
  return ok;
};

const validateNumber = (
  schema: JsonSchema,
  value: number,
  path: string,
  integer: boolean,
): ValidationResult => {
  if (integer && !Number.isInteger(value)) {
    return fail(path, "expected an integer");
  }
  const minimum = schema["minimum"];
  if (typeof minimum === "number" && value < minimum) {
    return fail(path, `number below minimum ${minimum}`);
  }
  const maximum = schema["maximum"];
  if (typeof maximum === "number" && value > maximum) {
    return fail(path, `number above maximum ${maximum}`);
  }
  return ok;
};

const validateArray = (
  schema: JsonSchema,
  value: readonly unknown[],
  path: string,
): ValidationResult => {
  const minItems = schema["minItems"];
  if (typeof minItems === "number" && value.length < minItems) {
    return fail(path, `array shorter than minItems ${minItems}`);
  }
  const maxItems = schema["maxItems"];
  if (typeof maxItems === "number" && value.length > maxItems) {
    return fail(path, `array longer than maxItems ${maxItems}`);
  }
  const items = schema["items"];
  if (isPlainObject(items)) {
    for (const [index, element] of value.entries()) {
      const result = validateValue(items, element, `${path}[${index}]`);
      if (!result.valid) {
        return result;
      }
    }
  }
  return ok;
};

const validateObject = (
  schema: JsonSchema,
  value: Record<string, unknown>,
  path: string,
): ValidationResult => {
  const properties = isPlainObject(schema["properties"])
    ? schema["properties"]
    : {};
  const allowsAdditional = schema["additionalProperties"] === true;

  const required = Array.isArray(schema["required"]) ? schema["required"] : [];
  for (const key of required) {
    if (typeof key === "string" && value[key] === undefined) {
      return fail(
        path === "" ? key : `${path}.${key}`,
        "missing required property",
      );
    }
  }

  for (const [key, child] of Object.entries(value)) {
    const childSchema = properties[key];
    const childPath = path === "" ? key : `${path}.${key}`;
    if (isPlainObject(childSchema)) {
      const result = validateValue(childSchema, child, childPath);
      if (!result.valid) {
        return result;
      }
      continue;
    }
    if (!allowsAdditional && Object.keys(properties).length > 0) {
      return fail(childPath, "unknown property");
    }
  }
  return ok;
};

const validateValue = (
  schema: JsonSchema,
  value: unknown,
  path: string,
): ValidationResult => {
  const values = enumValues(schema);
  if (values && !values.includes(value)) {
    return fail(path, `value is not one of ${JSON.stringify(values)}`);
  }

  const types = schemaTypes(schema);
  if (types.length === 0) {
    // A schema with no `type` (e.g. set_field_value.content.value) accepts any
    // JSON value; only its enum (checked above) constrains it.
    return ok;
  }

  if (value === null) {
    return types.includes("null")
      ? ok
      : fail(path, `null is not allowed (expected ${types.join("|")})`);
  }

  if (types.includes("string") && typeof value === "string") {
    return validateString(schema, value, path);
  }
  if (types.includes("integer") && typeof value === "number") {
    return validateNumber(schema, value, path, true);
  }
  if (types.includes("number") && typeof value === "number") {
    return validateNumber(schema, value, path, false);
  }
  if (types.includes("boolean") && typeof value === "boolean") {
    return ok;
  }
  if (types.includes("array") && Array.isArray(value)) {
    return validateArray(schema, value, path);
  }
  if (types.includes("object") && isPlainObject(value)) {
    return validateObject(schema, value, path);
  }

  return fail(path, `expected ${types.join("|")}`);
};

/**
 * Validate `data` against a tool's `inputSchema` in interpreted mode. The root
 * schema is always an object schema (`{ type: "object", properties }`).
 */
export const validateAgainstSchema = (
  schema: JsonSchema,
  data: unknown,
): ValidationResult => validateValue(schema, data, "");
