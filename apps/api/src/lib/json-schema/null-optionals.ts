import { Result } from "better-result";

import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

// The optional-null rule for agent and model input: a property the schema
// makes optional, and does not let be null, reads a `null` as omitted. Strict
// providers and MCP clients both spell an absent optional field as `null`.

const CONSTRAINING_KEYWORDS = [
  "type",
  "anyOf",
  "oneOf",
  "allOf",
  "enum",
  "const",
  "$ref",
] as const;

const admitsNull = (schema: unknown): boolean => {
  if (!isRecord(schema)) {
    return true;
  }
  // `nullable` is the OpenAPI spelling a provider-safe projection (Gemini)
  // gives a null union.
  if (schema["nullable"] === true) {
    return true;
  }
  const type = schema["type"];
  if (type === "null" || (isUnknownArray(type) && type.includes("null"))) {
    return true;
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (isUnknownArray(branches) && branches.some(admitsNull)) {
      return true;
    }
  }
  return CONSTRAINING_KEYWORDS.every((keyword) => !(keyword in schema));
};

const UNION_KEYWORDS = ["anyOf", "oneOf"] as const;

/**
 * Whether `text` matches a schema's `pattern`, or `undefined` when the pattern
 * does not compile as a Unicode expression: a third-party tool schema may
 * carry one (`^[a-z\_]+$`), and it must not fail the whole input.
 */
const matchesPattern = (pattern: string, text: string): boolean | undefined => {
  const compiled = Result.try(() => new RegExp(pattern, "u"));
  return Result.isOk(compiled) ? compiled.value.test(text) : undefined;
};

/**
 * Whether a union branch could be the one `value` was written for: no `const`
 * property of the branch (a discriminator) disagrees with the value. A branch
 * with no discriminator always could.
 */
const branchCouldMatch = (
  branch: Record<string, unknown>,
  value: Record<string, unknown>,
): boolean => {
  const properties = branch["properties"];
  if (!isRecord(properties)) {
    return true;
  }
  return Object.entries(properties).every(
    ([name, property]) =>
      !isRecord(property) ||
      !("const" in property) ||
      !(name in value) ||
      property["const"] === value[name],
  );
};

/**
 * A union node declares nothing itself: its members do. Without reading them,
 * an optional null inside a discriminated member (an array of `mode` variants)
 * reached validation and was refused.
 */
const matchingUnionBranches = (
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
): Record<string, unknown>[] => {
  const matching: Record<string, unknown>[] = [];
  for (const keyword of UNION_KEYWORDS) {
    const branches = schema[keyword];
    if (!isUnknownArray(branches)) {
      continue;
    }
    for (const branch of branches) {
      if (isRecord(branch) && branchCouldMatch(branch, value)) {
        matching.push(branch);
      }
    }
  }
  return matching;
};

const requiredNamesOf = (
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
): Set<unknown> => {
  const required = schema["required"];
  const names = new Set(isUnknownArray(required) ? required : []);
  for (const branch of matchingUnionBranches(schema, value)) {
    for (const name of requiredNamesOf(branch, value)) {
      names.add(name);
    }
  }
  return names;
};

/** The schemas a node itself, not its union branches, gives `key`. */
const ownChildSchemas = (
  schema: Record<string, unknown>,
  key: string,
): unknown[] => {
  const children: unknown[] = [];
  const properties = schema["properties"];
  if (isRecord(properties) && key in properties) {
    children.push(properties[key]);
  }
  const patternProperties = schema["patternProperties"];
  if (isRecord(patternProperties)) {
    for (const [pattern, childSchema] of Object.entries(patternProperties)) {
      if (matchesPattern(pattern, key) === true) {
        children.push(childSchema);
      }
    }
  }
  return children;
};

const objectChildSchemas = (
  schema: Record<string, unknown>,
  key: string,
  value: Record<string, unknown>,
): unknown[] => {
  const children: unknown[] = [];
  for (const branch of matchingUnionBranches(schema, value)) {
    children.push(...objectChildSchemas(branch, key, value));
  }
  children.push(...ownChildSchemas(schema, key));
  const additionalProperties = schema["additionalProperties"];
  if (children.length === 0 && isRecord(additionalProperties)) {
    children.push(additionalProperties);
  }
  return children;
};

/** Whether `value` is a placeholder `schema` rejects, standing for "not set". */
type AbsentPlaceholderTest = (value: unknown, schema: unknown) => boolean;

type PlaceholderSite = {
  entry: unknown;
  isAbsent: AbsentPlaceholderTest;
  key: string;
  value: Record<string, unknown>;
};

/**
 * Whether the node refuses `entry` at `key`. Every schema the node itself
 * gives the key applies, so one refusing it is enough; union branches are
 * alternatives, so every branch that declares the key must refuse it, or a
 * value valid under one branch would lose a field another branch refuses.
 */
const refusesPlaceholder = (
  schema: Record<string, unknown>,
  site: PlaceholderSite,
): boolean => {
  const { entry, isAbsent, key, value } = site;
  const branches = matchingUnionBranches(schema, value).filter(
    (branch) => objectChildSchemas(branch, key, value).length > 0,
  );
  const own = ownChildSchemas(schema, key);
  const additionalProperties = schema["additionalProperties"];
  if (
    own.length === 0 &&
    branches.length === 0 &&
    isRecord(additionalProperties)
  ) {
    own.push(additionalProperties);
  }
  if (own.some((childSchema) => isAbsent(entry, childSchema))) {
    return true;
  }
  return (
    branches.length > 0 &&
    branches.every((branch) => refusesPlaceholder(branch, site))
  );
};

const omitAbsentPlaceholders = (
  schema: unknown,
  value: unknown,
  isAbsent: AbsentPlaceholderTest,
): unknown => {
  if (!isRecord(schema)) {
    return value;
  }
  const items = schema["items"];
  if (items !== undefined && isUnknownArray(value)) {
    return value.map((entry) => omitAbsentPlaceholders(items, entry, isAbsent));
  }
  // An array under a union node is declared by its array members.
  if (isUnknownArray(value)) {
    let current: unknown = value;
    for (const keyword of UNION_KEYWORDS) {
      const branches = schema[keyword];
      for (const branch of isUnknownArray(branches) ? branches : []) {
        current = omitAbsentPlaceholders(branch, current, isAbsent);
      }
    }
    return current;
  }
  if (!isRecord(value)) {
    return value;
  }
  const requiredNames = requiredNamesOf(schema, value);
  const present: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const childSchemas = objectChildSchemas(schema, key, value);
    if (childSchemas.length === 0) {
      present[key] = entry;
      continue;
    }
    if (
      !requiredNames.has(key) &&
      refusesPlaceholder(schema, { entry, isAbsent, key, value })
    ) {
      continue;
    }
    let current = entry;
    for (const childSchema of childSchemas) {
      current = omitAbsentPlaceholders(childSchema, current, isAbsent);
    }
    present[key] = current;
  }
  return present;
};

const isRejectedNull: AbsentPlaceholderTest = (value, schema) =>
  value === null && !admitsNull(schema);

/**
 * JSON Schema string formats that no empty string satisfies. An unlisted
 * format is an annotation a validator may ignore, so it decides nothing.
 */
const EMPTY_REJECTING_FORMATS: ReadonlySet<string> = new Set([
  "date",
  "date-time",
  "time",
  "duration",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uri",
  "uuid",
]);

/**
 * Whether a schema refuses the empty string: a declared type other than
 * string, a string with a minimum length, a format "" cannot satisfy or a
 * pattern "" does not match, or an enum or constant without "". A union
 * refuses it only when every branch does. A schema that declares no type
 * accepts it.
 */
const rejectsEmptyString = (schema: unknown): boolean => {
  if (!isRecord(schema)) {
    return false;
  }
  for (const keyword of UNION_KEYWORDS) {
    const branches = schema[keyword];
    if (isUnknownArray(branches) && branches.length > 0) {
      return branches.every(rejectsEmptyString);
    }
  }
  const enumValues = schema["enum"];
  if (isUnknownArray(enumValues)) {
    return !enumValues.includes("");
  }
  if ("const" in schema) {
    return schema["const"] !== "";
  }
  const type = schema["type"];
  if (type === undefined) {
    return false;
  }
  const isString =
    type === "string" || (isUnknownArray(type) && type.includes("string"));
  // A declared type that is not a string refuses any string.
  if (!isString) {
    return true;
  }
  const minLength = schema["minLength"];
  if (typeof minLength === "number" && minLength > 0) {
    return true;
  }
  const format = schema["format"];
  if (typeof format === "string" && EMPTY_REJECTING_FORMATS.has(format)) {
    return true;
  }
  const pattern = schema["pattern"];
  return typeof pattern === "string" && matchesPattern(pattern, "") === false;
};

const isRejectedPlaceholder: AbsentPlaceholderTest = (value, schema) =>
  isRejectedNull(value, schema) || (value === "" && rejectsEmptyString(schema));

/**
 * Apply the common optional-null rule before any agent-value coercion. The
 * decision comes from the same schema validation will use: nullable values keep
 * null, required values still fail, and optional non-null values read null as
 * omission at every declared object level.
 */
export const withNullOptionalsOmitted = (
  schema: unknown,
  value: unknown,
): unknown => omitAbsentPlaceholders(schema, value, isRejectedNull);

/**
 * The same rule for a model's tool input, which also fills an optional string
 * it is not setting with "": that reads as omitted too, but only where the
 * property's own schema refuses "". Where "" is a value the property
 * accepts, it stays exactly as sent. This is the placeholder rule the MCP
 * input schemas apply (`nullAsAbsent`), read off JSON Schema.
 */
export const withModelPlaceholdersOmitted = (
  schema: unknown,
  value: unknown,
): unknown => omitAbsentPlaceholders(schema, value, isRejectedPlaceholder);

const NULL_SCHEMA = { type: "null" } as const;

/** Keywords past which a node is more than a bare `type`. */
const BEYOND_TYPE_KEYWORDS = [
  "anyOf",
  "oneOf",
  "allOf",
  "enum",
  "const",
  "$ref",
] as const;

/** `schema`, also admitting `null`. */
const admittingNull = (schema: unknown): unknown => {
  if (!isRecord(schema) || admitsNull(schema)) {
    return schema;
  }
  const type = schema["type"];
  if (BEYOND_TYPE_KEYWORDS.every((keyword) => !(keyword in schema))) {
    if (typeof type === "string") {
      return { ...schema, type: [type, "null"] };
    }
    if (isUnknownArray(type)) {
      return { ...schema, type: [...type, "null"] };
    }
  }
  return { anyOf: [schema, NULL_SCHEMA] };
};

/** The names a node requires, its union branches' included. */
const requiredAnywhere = (schema: Record<string, unknown>): Set<unknown> => {
  const required = schema["required"];
  const names = new Set<unknown>(isUnknownArray(required) ? required : []);
  for (const keyword of UNION_KEYWORDS) {
    const branches = schema[keyword];
    if (!isUnknownArray(branches)) {
      continue;
    }
    for (const branch of branches) {
      if (isRecord(branch)) {
        for (const name of requiredAnywhere(branch)) {
          names.add(name);
        }
      }
    }
  }
  return names;
};

const mapEntries = (
  record: Record<string, unknown>,
  map: (name: string, entry: unknown) => unknown,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(record).map(([name, entry]) => [name, map(name, entry)]),
  );

const NO_NAMES: ReadonlySet<unknown> = new Set();

/** A union branch's object is read with its parent's required names too. */
const widenOptionals = (
  schema: unknown,
  inheritedRequired: ReadonlySet<unknown>,
): unknown => {
  if (!isRecord(schema)) {
    return schema;
  }
  const widened: Record<string, unknown> = { ...schema };
  const required = requiredAnywhere(schema);
  for (const name of inheritedRequired) {
    required.add(name);
  }
  const properties = schema["properties"];
  if (isRecord(properties)) {
    widened["properties"] = mapEntries(properties, (name, property) => {
      const inner = widenOptionals(property, NO_NAMES);
      return required.has(name) ? inner : admittingNull(inner);
    });
  }
  const patternProperties = schema["patternProperties"];
  if (isRecord(patternProperties)) {
    widened["patternProperties"] = mapEntries(
      patternProperties,
      (_name, entry) => widenOptionals(entry, NO_NAMES),
    );
  }
  for (const keyword of ["additionalProperties", "items"] as const) {
    if (isRecord(schema[keyword])) {
      widened[keyword] = widenOptionals(schema[keyword], NO_NAMES);
    }
  }
  for (const keyword of UNION_KEYWORDS) {
    const branches = schema[keyword];
    if (isUnknownArray(branches)) {
      widened[keyword] = branches.map((branch) =>
        widenOptionals(branch, required),
      );
    }
  }
  return widened;
};

/**
 * `schema` with every optional property also admitting `null`, at every level
 * `withModelPlaceholdersOmitted` reads: the spelling a model can use for "not
 * set" on a route that treats every declared field as one to fill. Read
 * against the original schema, `withModelPlaceholdersOmitted` drops exactly
 * those nulls again, so the input a tool receives keeps its declared shape.
 */
export const withOptionalsNullable = (schema: unknown): unknown =>
  widenOptionals(schema, NO_NAMES);
