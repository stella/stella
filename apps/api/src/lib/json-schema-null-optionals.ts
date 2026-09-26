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

const objectChildSchemas = (
  schema: Record<string, unknown>,
  key: string,
  value: Record<string, unknown>,
): unknown[] => {
  const children: unknown[] = [];
  for (const branch of matchingUnionBranches(schema, value)) {
    children.push(...objectChildSchemas(branch, key, value));
  }
  const properties = schema["properties"];
  if (isRecord(properties) && key in properties) {
    children.push(properties[key]);
  }
  const patternProperties = schema["patternProperties"];
  if (isRecord(patternProperties)) {
    for (const [pattern, childSchema] of Object.entries(patternProperties)) {
      if (new RegExp(pattern, "u").test(key)) {
        children.push(childSchema);
      }
    }
  }
  const additionalProperties = schema["additionalProperties"];
  if (children.length === 0 && isRecord(additionalProperties)) {
    children.push(additionalProperties);
  }
  return children;
};

/**
 * Apply the common optional-null rule before any agent-value coercion. The
 * decision comes from the same schema validation will use: nullable values keep
 * null, required values still fail, and optional non-null values read null as
 * omission at every declared object level.
 */
export const withNullOptionalsOmitted = (
  schema: unknown,
  value: unknown,
): unknown => {
  if (!isRecord(schema)) {
    return value;
  }
  const items = schema["items"];
  if (items !== undefined && isUnknownArray(value)) {
    return value.map((entry) => withNullOptionalsOmitted(items, entry));
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
      entry === null &&
      !requiredNames.has(key) &&
      childSchemas.some((childSchema) => !admitsNull(childSchema))
    ) {
      continue;
    }
    let current = entry;
    for (const childSchema of childSchemas) {
      current = withNullOptionalsOmitted(childSchema, current);
    }
    present[key] = current;
  }
  return present;
};
