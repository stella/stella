import { panic } from "better-result";

import { normalizeBoolean } from "./boolean";
import type { CountrySpelling } from "./country";
import { countryCodeIn, normalizeCountry } from "./country";
import { normalizeDateFormatSpec } from "./date-format-spec";
import { normalizeDateValue } from "./date-value";
import { normalizeEnumValue } from "./enum-value";
import { normalizeLocale } from "./locale";
import type { Normalized } from "./normalized";
import { normalizeNumber } from "./number";

export const AGENT_INPUT_NORMALIZATION_KEY = "x-stella-agent-input";

export const AGENT_INPUT_NORMALIZATION_KIND = {
  boolean: "boolean",
  country: "country",
  date: "date",
  dateFormat: "date-format",
  enum: "enum",
  locale: "locale",
  number: "number",
} as const;

export type AgentInputNormalizationKind =
  (typeof AGENT_INPUT_NORMALIZATION_KIND)[keyof typeof AGENT_INPUT_NORMALIZATION_KIND];

/**
 * What a country field needs beyond its kind: which ISO spelling the surface
 * stores, and the codes it holds law for, so the ask names the tool to call and
 * the values there are to ask for.
 */
export type AgentInputCountryAnnotation = {
  spelling: CountrySpelling;
  admitted?: readonly string[];
  tool?: string;
};

export type AgentInputNormalizationAnnotation = {
  kind: AgentInputNormalizationKind;
  /** Preserve invalid input only when the owning handler deliberately repairs it. */
  invalidValueDisposition?: "handler-owned";
  /** Locale context disambiguates numeric grouping and adds named date months. */
  locale?: string;
  /** Required by the `country` kind, which has two canonical spellings. */
  country?: AgentInputCountryAnnotation;
};

/** Attach an explicit normalization kind to a canonical JSON Schema field. */
export const agentInputNormalization = (
  annotation: AgentInputNormalizationAnnotation,
): Record<
  typeof AGENT_INPUT_NORMALIZATION_KEY,
  AgentInputNormalizationAnnotation
> => ({ [AGENT_INPUT_NORMALIZATION_KEY]: annotation });

/** Concise model guidance derived from the same kind dispatch executes. */
export const agentInputNormalizationGuidance = (
  annotation: AgentInputNormalizationAnnotation,
): string => {
  switch (annotation.kind) {
    case "boolean":
      return "Use a JSON boolean; common unambiguous yes/no words are normalized.";
    case "country":
      return "An ISO 3166-1 alpha-3 or alpha-2 code, or the country's name, is read.";
    case "date":
      return "Use ISO YYYY-MM-DD; unambiguous localized calendar dates are normalized.";
    case "date-format":
      return (
        'Use an object with a BCP-47 locale, such as {"locale":"en-GB","style":"short"}; ' +
        'an unambiguous combined string such as "en-GB-short" is normalized.'
      );
    case "enum":
      return "Use an advertised value; case and surrounding whitespace are normalized.";
    case "locale":
      return 'Use a BCP-47 language tag, for example "cs" or "en-GB".';
    case "number":
      return "Use a JSON number; unambiguous localized numeric notation is normalized.";
    default:
      annotation.kind satisfies never;
      return panic("Unhandled agent input normalization kind");
  }
};

/** Schema metadata shared by MCP descriptions and generated CLI help. */
export const agentInputNormalizationMetadata = (
  annotation: AgentInputNormalizationAnnotation,
  description?: string,
): ReturnType<typeof agentInputNormalization> & { description: string } => {
  const guidance = agentInputNormalizationGuidance(annotation);
  const authored = description?.trim();
  return {
    ...agentInputNormalization(annotation),
    description:
      authored === undefined || authored.length === 0
        ? guidance
        : `${authored}${/[.!?]$/u.test(authored) ? " " : ". "}${guidance}`,
  };
};

export type AgentInputNormalizationIssue = {
  path: string;
  received: string;
  expected: string;
  hint: string;
};

export type AgentInputNormalizationResult =
  | { ok: true; value: unknown; notes: readonly string[] }
  | { ok: false; issues: readonly AgentInputNormalizationIssue[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUnknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);

const joinPath = (path: string, segment: string): string =>
  path.length === 0 ? segment : `${path}.${segment}`;

const annotationOf = (
  schema: Record<string, unknown>,
): AgentInputNormalizationAnnotation | undefined => {
  const annotation = schema[AGENT_INPUT_NORMALIZATION_KEY];
  if (!isRecord(annotation)) {
    return undefined;
  }
  const kind = annotation["kind"];
  const normalizedKind = Object.values(AGENT_INPUT_NORMALIZATION_KIND).find(
    (candidate) => candidate === kind,
  );
  if (normalizedKind === undefined) {
    return undefined;
  }
  const locale = annotation["locale"];
  const invalidValueDisposition = annotation["invalidValueDisposition"];
  const country = countryAnnotationOf(annotation["country"]);
  return {
    kind: normalizedKind,
    ...(invalidValueDisposition === "handler-owned"
      ? { invalidValueDisposition }
      : {}),
    ...(typeof locale === "string" ? { locale } : {}),
    ...(country === undefined ? {} : { country }),
  };
};

/** The country half of an annotation, read back from the emitted schema. */
const countryAnnotationOf = (
  value: unknown,
): AgentInputCountryAnnotation | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const spelling = value["spelling"];
  if (spelling !== "alpha-3" && spelling !== "alpha-2") {
    return undefined;
  }
  const admitted = value["admitted"];
  const tool = value["tool"];
  return {
    spelling,
    ...(isUnknownArray(admitted) &&
    admitted.every((code) => typeof code === "string")
      ? { admitted }
      : {}),
    ...(typeof tool === "string" ? { tool } : {}),
  };
};

const stringEnumOf = (
  schema: Record<string, unknown>,
): readonly string[] | undefined => {
  const values = schema["enum"];
  if (
    isUnknownArray(values) &&
    values.length > 0 &&
    values.every((value) => typeof value === "string")
  ) {
    return values;
  }
  if (typeof schema["const"] === "string") {
    return [schema["const"]];
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (!isUnknownArray(branches)) {
      continue;
    }
    const literals: string[] = [];
    for (const branch of branches) {
      if (!isRecord(branch)) {
        return undefined;
      }
      if (branch["type"] === "null") {
        continue;
      }
      if (typeof branch["const"] !== "string") {
        return undefined;
      }
      literals.push(branch["const"]);
    }
    return literals.length > 0 ? literals : undefined;
  }
  return undefined;
};

const inferredAnnotationOf = (
  schema: Record<string, unknown>,
): AgentInputNormalizationAnnotation | undefined => {
  const explicit = annotationOf(schema);
  if (explicit !== undefined) {
    return explicit;
  }
  if (schema["format"] === "date") {
    return { kind: AGENT_INPUT_NORMALIZATION_KIND.date };
  }
  const types = isUnknownArray(schema["type"])
    ? schema["type"]
    : [schema["type"]];
  if (types.includes("number") || types.includes("integer")) {
    return { kind: AGENT_INPUT_NORMALIZATION_KIND.number };
  }
  if (types.includes("boolean")) {
    return { kind: AGENT_INPUT_NORMALIZATION_KIND.boolean };
  }
  return stringEnumOf(schema) === undefined
    ? undefined
    : { kind: AGENT_INPUT_NORMALIZATION_KIND.enum };
};

/**
 * A country field carries a string, not the pair the reader returns, so the
 * canonical value is projected into the spelling the surface stores. The
 * annotation is what says which one; a country field declared without it would
 * silently store alpha-3 where a column holds alpha-2, so it is required.
 */
const normalizeCountryLeaf = ({
  annotation,
  path,
  value,
}: {
  annotation: AgentInputNormalizationAnnotation;
  path: string;
  value: unknown;
}): Normalized<unknown> => {
  const country =
    annotation.country ??
    panic("A country agent input must declare which ISO spelling it stores");
  const spelling: CountrySpelling = country.spelling;
  const read = normalizeCountry(value, {
    spelling,
    admitted: country.admitted,
    tool: country.tool,
    parameter: path.split(".").at(-1),
  });
  return read.ok
    ? {
        ok: true,
        value: countryCodeIn(read.value, spelling),
        ...(read.note === undefined ? {} : { note: read.note }),
      }
    : read;
};

const normalizeLeaf = ({
  annotation,
  path,
  schema,
  value,
}: {
  annotation: AgentInputNormalizationAnnotation;
  /** Dotted path of the field, whose last segment is the property an ask names. */
  path: string;
  schema: Record<string, unknown>;
  value: unknown;
}): Normalized<unknown> => {
  switch (annotation.kind) {
    case "boolean":
      return normalizeBoolean(value);
    case "country":
      return normalizeCountryLeaf({ annotation, path, value });
    case "date":
      return normalizeDateValue(
        value,
        annotation.locale === undefined
          ? undefined
          : { locales: [annotation.locale] },
      );
    case "date-format":
      return normalizeDateFormatSpec(value);
    case "enum":
      return normalizeEnumValue(value, stringEnumOf(schema) ?? []);
    case "locale":
      return normalizeLocale(value);
    case "number":
      return normalizeNumber(
        value,
        annotation.locale === undefined
          ? undefined
          : { locale: annotation.locale },
      );
    default:
      annotation.kind satisfies never;
      return panic("Unhandled agent input normalization kind");
  }
};

type WalkResult =
  | { status: "normalized"; value: unknown; notes: string[] }
  | { status: "invalid"; issues: AgentInputNormalizationIssue[] }
  | { status: "not-applicable" };

type WalkContext = {
  rootSchema: unknown;
  remainingReferenceDepth: number;
};

const MAX_SCHEMA_REFERENCE_DEPTH = 64;

const valueMatchesType = (type: unknown, value: unknown): boolean => {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean" || typeof value === "string";
    case "integer":
    case "number":
      return typeof value === "number" || typeof value === "string";
    case "null":
      return value === null;
    case "object":
      return isRecord(value);
    case "string":
      return typeof value === "string";
    default:
      return true;
  }
};

const walkUnion = ({
  branches,
  value,
  path,
  context,
}: {
  branches: readonly unknown[];
  value: unknown;
  path: string;
  context: WalkContext;
}): WalkResult => {
  const results = branches
    .filter(
      (branch) => isRecord(branch) && valueMatchesType(branch["type"], value),
    )
    .map((branch) => walkSchema({ schema: branch, value, path, context }));
  const successful = results.filter(
    (result): result is Extract<WalkResult, { status: "normalized" }> =>
      result.status === "normalized",
  );
  if (successful.length === 0) {
    if (results.some((result) => result.status === "not-applicable")) {
      return { status: "not-applicable" };
    }
    const invalid = results.filter(
      (result): result is Extract<WalkResult, { status: "invalid" }> =>
        result.status === "invalid",
    );
    return invalid.length === 1
      ? (invalid.at(0) ?? { status: "not-applicable" })
      : { status: "not-applicable" };
  }
  const canonical = new Map<string, (typeof successful)[number]>();
  for (const result of successful) {
    canonical.set(JSON.stringify(result.value), result);
  }
  if (canonical.size !== 1) {
    return { status: "not-applicable" };
  }
  return canonical.values().next().value ?? { status: "not-applicable" };
};

const resolveLocalReference = (
  reference: string,
  rootSchema: unknown,
): unknown => {
  if (reference === "#") {
    return rootSchema;
  }
  if (!reference.startsWith("#/")) {
    return undefined;
  }
  let resolved = rootSchema;
  for (const rawSegment of reference.slice(2).split("/")) {
    if (!isRecord(resolved)) {
      return undefined;
    }
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    resolved = resolved[segment];
  }
  return resolved;
};

const walkIntersection = ({
  schema,
  branches,
  value,
  path,
  context,
}: {
  schema: Record<string, unknown>;
  branches: readonly unknown[];
  value: unknown;
  path: string;
  context: WalkContext;
}): WalkResult => {
  let current = value;
  const notes: string[] = [];
  const issues: AgentInputNormalizationIssue[] = [];
  let applied = false;
  for (const branch of branches) {
    const result = walkSchema({
      schema: branch,
      value: current,
      path,
      context,
    });
    if (result.status === "invalid") {
      issues.push(...result.issues);
      continue;
    }
    if (result.status === "normalized") {
      applied = true;
      current = result.value;
      notes.push(...result.notes);
    }
  }
  if (issues.length > 0) {
    return { status: "invalid", issues };
  }
  const { allOf: _allOf, ...siblings } = schema;
  const siblingResult = walkSchema({
    schema: siblings,
    value: current,
    path,
    context,
  });
  if (siblingResult.status === "invalid") {
    return siblingResult;
  }
  if (siblingResult.status === "normalized") {
    return {
      status: "normalized",
      value: siblingResult.value,
      notes: [...notes, ...siblingResult.notes],
    };
  }
  return applied
    ? { status: "normalized", value: current, notes }
    : { status: "not-applicable" };
};

const walkSchema = ({
  schema,
  value,
  path,
  context,
}: {
  schema: unknown;
  value: unknown;
  path: string;
  context: WalkContext;
}): WalkResult => {
  if (!isRecord(schema)) {
    return { status: "not-applicable" };
  }

  const reference = schema["$ref"];
  if (typeof reference === "string") {
    if (context.remainingReferenceDepth === 0) {
      return { status: "not-applicable" };
    }
    const resolved = resolveLocalReference(reference, context.rootSchema);
    return resolved === undefined || resolved === schema
      ? { status: "not-applicable" }
      : walkSchema({
          schema: resolved,
          value,
          path,
          context: {
            ...context,
            remainingReferenceDepth: context.remainingReferenceDepth - 1,
          },
        });
  }

  const intersections = schema["allOf"];
  if (isUnknownArray(intersections)) {
    return walkIntersection({
      schema,
      branches: intersections,
      value,
      path,
      context,
    });
  }

  const explicitAnnotation = annotationOf(schema);
  if (explicitAnnotation === undefined) {
    for (const keyword of ["anyOf", "oneOf"] as const) {
      const branches = schema[keyword];
      if (isUnknownArray(branches)) {
        return walkUnion({ branches, value, path, context });
      }
    }
  }

  const annotation = explicitAnnotation ?? inferredAnnotationOf(schema);
  const types = isUnknownArray(schema["type"])
    ? schema["type"]
    : [schema["type"]];
  if (annotation !== undefined && !(value === null && types.includes("null"))) {
    const normalized = normalizeLeaf({ annotation, path, schema, value });
    if (!normalized.ok) {
      if (annotation.invalidValueDisposition === "handler-owned") {
        return { status: "not-applicable" };
      }
      const { expected, hint, received } = normalized;
      return {
        status: "invalid",
        issues: [{ path, received, expected, hint }],
      };
    }
    return {
      status: "normalized",
      value: normalized.value,
      notes: normalized.note === undefined ? [] : [normalized.note],
    };
  }

  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (isUnknownArray(branches)) {
      return walkUnion({ branches, value, path, context });
    }
  }

  const properties = schema["properties"];
  const patternProperties = schema["patternProperties"];
  if (
    isRecord(value) &&
    (isRecord(properties) || isRecord(patternProperties))
  ) {
    const output: Record<string, unknown> = { ...value };
    const notes: string[] = [];
    const issues: AgentInputNormalizationIssue[] = [];
    for (const [key, entry] of Object.entries(value)) {
      const childSchemas: unknown[] = [];
      if (isRecord(properties) && key in properties) {
        childSchemas.push(properties[key]);
      }
      if (isRecord(patternProperties)) {
        for (const [pattern, childSchema] of Object.entries(
          patternProperties,
        )) {
          if (new RegExp(pattern, "u").test(key)) {
            childSchemas.push(childSchema);
          }
        }
      }
      const additionalProperties = schema["additionalProperties"];
      if (childSchemas.length === 0 && isRecord(additionalProperties)) {
        childSchemas.push(additionalProperties);
      }
      if (childSchemas.length === 0) {
        continue;
      }
      let current = entry;
      for (const childSchema of childSchemas) {
        const child = walkSchema({
          schema: childSchema,
          value: current,
          path: joinPath(path, key),
          context,
        });
        if (child.status === "invalid") {
          issues.push(...child.issues);
          continue;
        }
        if (child.status === "normalized") {
          current = child.value;
          notes.push(...child.notes);
        }
      }
      output[key] = current;
    }
    return issues.length > 0
      ? { status: "invalid", issues }
      : { status: "normalized", value: output, notes };
  }

  const items = schema["items"];
  if (items !== undefined && isUnknownArray(value)) {
    const output: unknown[] = [];
    const notes: string[] = [];
    const issues: AgentInputNormalizationIssue[] = [];
    for (const [index, entry] of value.entries()) {
      const child = walkSchema({
        schema: items,
        value: entry,
        path: joinPath(path, String(index)),
        context,
      });
      if (child.status === "invalid") {
        issues.push(...child.issues);
        output.push(entry);
        continue;
      }
      output.push(child.status === "normalized" ? child.value : entry);
      if (child.status === "normalized") {
        notes.push(...child.notes);
      }
    }
    return issues.length > 0
      ? { status: "invalid", issues }
      : { status: "normalized", value: output, notes };
  }

  return { status: "not-applicable" };
};

/**
 * Normalize one agent-written value from its canonical JSON Schema. Standard
 * `type`, `format: date`, and string `enum` keywords are the annotations for
 * numbers, booleans, dates, and closed vocabularies. The extension key handles
 * kinds JSON Schema cannot name, such as locales and date-format specs.
 */
export const normalizeAgentInput = ({
  path = "",
  schema,
  value,
}: {
  path?: string;
  schema: unknown;
  value: unknown;
}): AgentInputNormalizationResult => {
  const result = walkSchema({
    schema,
    value,
    path,
    context: {
      rootSchema: schema,
      remainingReferenceDepth: MAX_SCHEMA_REFERENCE_DEPTH,
    },
  });
  if (result.status === "invalid") {
    return { ok: false, issues: result.issues };
  }
  return result.status === "normalized"
    ? { ok: true, value: result.value, notes: result.notes }
    : { ok: true, value, notes: [] };
};
