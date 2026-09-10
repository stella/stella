import { panic } from "better-result";

import { normalizeAgentInput } from "@stll/agent-input";

import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import type { McpValidationIssue } from "@/api/mcp/error-codes";
import type { InternalToolErrorResult } from "@/api/mcp/tool-types";
import { structuredErrorResult } from "@/api/mcp/tool-utils";

type BoundaryNormalizationResult<TValue> =
  | { ok: true; value: TValue; notes: readonly string[] }
  | { ok: false; issues: readonly McpValidationIssue[]; hint: string };

export type BoundaryNormalizationFailure = Extract<
  BoundaryNormalizationResult<unknown>,
  { ok: false }
>;

const toBoundaryNormalizationFailure = (
  issues: readonly {
    path: string;
    received: string;
    expected: string;
    hint: string;
  }[],
): BoundaryNormalizationFailure => ({
  ok: false,
  issues: issues.map(({ path, received, expected }): McpValidationIssue => ({
    path,
    message: `${received} is not ${expected}.`,
  })),
  hint: issues
    .map(({ path, hint }) => (path.length === 0 ? hint : `${path}: ${hint}`))
    .join(" "),
});

export const agentInputValidationError = ({
  failure,
  subject,
}: {
  failure: BoundaryNormalizationFailure;
  subject: string;
}): InternalToolErrorResult =>
  structuredErrorResult({
    code: "validation_error",
    message: `${subject} need clarification`,
    issues: [...failure.issues],
    hint: failure.hint,
  });

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

const objectChildSchemas = (
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
  const required = schema["required"];
  const requiredNames = new Set(isUnknownArray(required) ? required : []);
  const present: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const childSchemas = objectChildSchemas(schema, key);
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
    present[key] = childSchemas.reduce(
      (current, childSchema) => withNullOptionalsOmitted(childSchema, current),
      entry,
    );
  }
  return present;
};

/**
 * Report keys the schema cleaner removed. Capability handlers intentionally use
 * the REST cleaner after conversion, but agent callers need typos rejected
 * rather than silently discarded. Comparing before and after keeps this guard
 * derived from the same schema operation that decides which keys are declared.
 */
export const findRemovedInputIssues = ({
  allowedRemovedPaths = [],
  before,
  after,
  path,
}: {
  allowedRemovedPaths?: readonly string[];
  before: unknown;
  after: unknown;
  path: string;
}): McpValidationIssue[] => {
  if (isUnknownArray(before) && isUnknownArray(after)) {
    return before.flatMap((entry, index) =>
      findRemovedInputIssues({
        allowedRemovedPaths,
        before: entry,
        after: after[index],
        path: `${path}.${index}`,
      }),
    );
  }
  if (!isRecord(before) || !isRecord(after)) {
    return [];
  }
  const issues: McpValidationIssue[] = [];
  for (const [key, value] of Object.entries(before)) {
    const fieldPath = path.length === 0 ? key : `${path}.${key}`;
    if (!(key in after)) {
      if (allowedRemovedPaths.includes(fieldPath)) {
        continue;
      }
      issues.push({ path: fieldPath, message: `Unknown parameter: ${key}` });
      continue;
    }
    issues.push(
      ...findRemovedInputIssues({
        allowedRemovedPaths,
        before: value,
        after: after[key],
        path: fieldPath,
      }),
    );
  }
  return issues;
};

export const normalizeInputAtBoundary = ({
  path = "",
  schema,
  value,
}: {
  path?: string;
  schema: unknown;
  value: unknown;
}): BoundaryNormalizationResult<unknown> => {
  const withoutNullOptionals = withNullOptionalsOmitted(schema, value);
  const normalized = normalizeAgentInput({
    path,
    schema,
    value: withoutNullOptionals,
  });
  if (!normalized.ok) {
    return toBoundaryNormalizationFailure(normalized.issues);
  }
  return normalized;
};

export const normalizeObjectInputAtBoundary = ({
  exactProperties = [],
  schema,
  value,
}: {
  /** Boundary-control booleans must retain literal JSON semantics. */
  exactProperties?: readonly string[];
  schema: unknown;
  value: Record<string, unknown>;
}): BoundaryNormalizationResult<Record<string, unknown>> => {
  const properties = isRecord(schema) ? schema["properties"] : undefined;
  const normalizationSchema =
    isRecord(schema) && isRecord(properties) && exactProperties.length > 0
      ? {
          ...schema,
          properties: Object.fromEntries(
            Object.entries(properties).map(([key, property]) => [
              key,
              exactProperties.includes(key) ? {} : property,
            ]),
          ),
        }
      : schema;
  const withoutNullOptionals = withNullOptionalsOmitted(schema, value);
  const normalized = normalizeAgentInput({
    schema: normalizationSchema,
    value: withoutNullOptionals,
  });
  if (!normalized.ok) {
    return toBoundaryNormalizationFailure(normalized.issues);
  }
  return isRecord(normalized.value)
    ? { ok: true, value: normalized.value, notes: normalized.notes }
    : panic("An object input schema normalized to a non-object value");
};
