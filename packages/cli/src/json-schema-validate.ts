// Interpreted JSON-Schema validator for the `--input` escape hatch (spec 051
// S5.5 rule 1): it walks the schema and the data recursively, with NO
// `Function`/`eval`/dynamic code generation. Scoped to exactly the shapes the
// MCP prop builders emit (string, nullable-string, integer/number with
// min/max, enum, boolean, array + items, object + properties, free map). A
// hand-rolled walker is simpler and lighter than a general-purpose library for
// this closed shape set, and it structurally cannot run generated code.

import { compileSchemaPattern } from "./schema-pattern.js";
import type { CompiledSchemaPattern } from "./schema-pattern.js";

type JsonSchema = Record<string, unknown>;
type ValidCompiledSchemaPattern = Extract<
  CompiledSchemaPattern,
  { status: "valid" }
>;

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

const applicatorKeywords = ["allOf", "anyOf", "oneOf"] as const;

const hasPropertiesAcrossCompositions = (schema: JsonSchema): boolean => {
  const properties = schema["properties"];
  if (isPlainObject(properties) && Object.keys(properties).length > 0) {
    return true;
  }
  return applicatorKeywords.some((keyword) => {
    const branches = schema[keyword];
    return (
      Array.isArray(branches) &&
      branches.some(
        (branch) =>
          isPlainObject(branch) && hasPropertiesAcrossCompositions(branch),
      )
    );
  });
};

const propertyDeclaredAcrossMatchingCompositions = (
  schema: JsonSchema,
  property: string,
  value: Record<string, unknown>,
  path: string,
): boolean => {
  const properties = schema["properties"];
  if (isPlainObject(properties) && Object.hasOwn(properties, property)) {
    return true;
  }
  const intersections = schema["allOf"];
  if (
    Array.isArray(intersections) &&
    intersections.some(
      (intersection) =>
        isPlainObject(intersection) &&
        propertyDeclaredAcrossMatchingCompositions(
          intersection,
          property,
          value,
          path,
        ),
    )
  ) {
    return true;
  }
  return (["anyOf", "oneOf"] as const).some((keyword) => {
    const branches = schema[keyword];
    return (
      Array.isArray(branches) &&
      branches.some(
        (branch) =>
          isPlainObject(branch) &&
          validateValue(branch, value, path, true).valid &&
          propertyDeclaredAcrossMatchingCompositions(
            branch,
            property,
            value,
            path,
          ),
      )
    );
  });
};

const hasObjectConstraintsAcrossCompositions = (
  schema: JsonSchema,
): boolean => {
  const required = schema["required"];
  if (
    hasPropertiesAcrossCompositions(schema) ||
    Object.hasOwn(schema, "patternProperties") ||
    (Array.isArray(required) && required.length > 0) ||
    Object.hasOwn(schema, "additionalProperties")
  ) {
    return true;
  }
  return applicatorKeywords.some((keyword) => {
    const branches = schema[keyword];
    return (
      Array.isArray(branches) &&
      branches.some(
        (branch) =>
          isPlainObject(branch) &&
          hasObjectConstraintsAcrossCompositions(branch),
      )
    );
  });
};

const jsonValuesEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (!isPlainObject(left) || !isPlainObject(right)) {
    return false;
  }
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) {
    return false;
  }
  return leftKeys.every(
    (key) =>
      Object.hasOwn(right, key) && jsonValuesEqual(left[key], right[key]),
  );
};

const validateSchemaList = (
  keyword: "allOf" | "anyOf" | "oneOf",
  branches: readonly unknown[],
  value: unknown,
  path: string,
): ValidationResult => {
  if (keyword === "allOf") {
    for (const branch of branches) {
      if (!isPlainObject(branch)) {
        return fail(path, "allOf contains a non-object schema");
      }
      const result = validateValue(branch, value, path, true);
      if (!result.valid) {
        return result;
      }
    }
    return ok;
  }
  if (keyword === "oneOf") {
    let matches = 0;
    for (const branch of branches) {
      if (
        isPlainObject(branch) &&
        validateValue(branch, value, path, true).valid
      ) {
        matches += 1;
      }
    }
    return matches === 1
      ? ok
      : fail(path, `value must match exactly one schema (matched ${matches})`);
  }
  for (const branch of branches) {
    if (
      isPlainObject(branch) &&
      validateValue(branch, value, path, true).valid
    ) {
      return ok;
    }
  }
  return fail(path, "value does not match any allowed schema");
};

const validateString = (
  schema: JsonSchema,
  value: string,
  path: string,
): ValidationResult => {
  const codePointLength = Array.from(value).length;
  const minLength = schema["minLength"];
  if (typeof minLength === "number" && codePointLength < minLength) {
    return fail(path, `string shorter than minLength ${minLength}`);
  }
  const maxLength = schema["maxLength"];
  if (typeof maxLength === "number" && codePointLength > maxLength) {
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

const validateRegExpString = (
  schema: JsonSchema,
  value: string,
  path: string,
): ValidationResult => {
  const source = schema["source"];
  if (typeof source !== "string") {
    return fail(path, "RegExp schema is missing its source");
  }
  const flags = schema["flags"];
  if (flags !== undefined && typeof flags !== "string") {
    return fail(path, "RegExp schema flags must be a string");
  }
  const compiled = compileSchemaPattern(source, flags);
  if (compiled.status === "invalid") {
    return fail(path, "RegExp schema contains an invalid source");
  }
  return compiled.regex.test(value)
    ? ok
    : fail(path, `string does not match pattern ${source}`);
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
  allowUnknownProperties: boolean,
): ValidationResult => {
  const properties = isPlainObject(schema["properties"])
    ? schema["properties"]
    : {};
  const rawPatternProperties = schema["patternProperties"];
  if (
    rawPatternProperties !== undefined &&
    !isPlainObject(rawPatternProperties)
  ) {
    return fail(path, "patternProperties must be an object");
  }
  const patternProperties = isPlainObject(rawPatternProperties)
    ? rawPatternProperties
    : {};
  const compiledPatternProperties: {
    pattern: ValidCompiledSchemaPattern;
    schema: JsonSchema;
  }[] = [];
  for (const [pattern, patternSchema] of Object.entries(patternProperties)) {
    if (!isPlainObject(patternSchema)) {
      return fail(path, "patternProperties contains a non-object schema");
    }
    const compiled = compileSchemaPattern(pattern);
    if (compiled.status === "invalid") {
      return fail(path, "schema contains an invalid property pattern");
    }
    compiledPatternProperties.push({
      pattern: compiled,
      schema: patternSchema,
    });
  }
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
    let declared = false;
    if (isPlainObject(childSchema)) {
      const result = validateValue(childSchema, child, childPath);
      if (!result.valid) {
        return result;
      }
      declared = true;
    }
    for (const patternProperty of compiledPatternProperties) {
      if (!patternProperty.pattern.regex.test(key)) {
        continue;
      }
      const result = validateValue(patternProperty.schema, child, childPath);
      if (!result.valid) {
        return result;
      }
      declared = true;
    }
    if (declared) {
      continue;
    }
    const additionalSchema = schema["additionalProperties"];
    if (isPlainObject(additionalSchema)) {
      const result = validateValue(additionalSchema, child, childPath);
      if (!result.valid) {
        return result;
      }
      continue;
    }
    if (
      additionalSchema !== false &&
      propertyDeclaredAcrossMatchingCompositions(schema, key, value, path)
    ) {
      // A matching composition branch already validated this value. The CLI's
      // implicit default-closed policy composes declared properties, while an
      // explicit additionalProperties:false remains strictly branch-local.
      continue;
    }
    if (
      additionalSchema === false ||
      (additionalSchema !== true &&
        !allowUnknownProperties &&
        hasPropertiesAcrossCompositions(schema))
    ) {
      return fail(childPath, "unknown property");
    }
  }
  return ok;
};

const validateValue = (
  schema: JsonSchema,
  value: unknown,
  path: string,
  allowUnknownProperties = false,
): ValidationResult => {
  if (
    Object.hasOwn(schema, "const") &&
    !jsonValuesEqual(schema["const"], value)
  ) {
    return fail(path, `value must equal ${JSON.stringify(schema["const"])}`);
  }

  const allOf = schema["allOf"];
  if (Array.isArray(allOf)) {
    const result = validateSchemaList("allOf", allOf, value, path);
    if (!result.valid) {
      return result;
    }
  }

  const anyOf = schema["anyOf"];
  if (Array.isArray(anyOf)) {
    const result = validateSchemaList("anyOf", anyOf, value, path);
    if (!result.valid) {
      return result;
    }
  }

  const oneOf = schema["oneOf"];
  if (Array.isArray(oneOf)) {
    const result = validateSchemaList("oneOf", oneOf, value, path);
    if (!result.valid) {
      return result;
    }
  }

  const values = enumValues(schema);
  if (values && !values.includes(value)) {
    return fail(path, `value is not one of ${JSON.stringify(values)}`);
  }

  const types = schemaTypes(schema);
  if (types.length === 0) {
    if (
      isPlainObject(value) &&
      hasObjectConstraintsAcrossCompositions(schema)
    ) {
      return validateObject(schema, value, path, allowUnknownProperties);
    }
    // A schema with no `type` (e.g. set_field_value.content.value) accepts any
    // JSON value; applicators, const, and enum above may still constrain it.
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
  if (types.includes("RegExp") && typeof value === "string") {
    return validateRegExpString(schema, value, path);
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
    return validateObject(schema, value, path, allowUnknownProperties);
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
