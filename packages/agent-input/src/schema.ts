import { panic } from "better-result";

import { isAbsentPlaceholder } from "./absent";
import { normalizeBoolean } from "./boolean";
import type { CountrySpelling } from "./country";
import { countryCodeIn, normalizeCountry } from "./country";
import { normalizeDateFormatSpec } from "./date-format-spec";
import { normalizeDateBound, normalizeDateValue } from "./date-value";
import type { EliOptions } from "./eli";
import { normalizeEli } from "./eli";
import { normalizeEnumValue } from "./enum-value";
import { normalizeLocale } from "./locale";
import type { Normalized, NormalizedOptional } from "./normalized";
import { readAsAbsent } from "./normalized";
import { normalizeNumber, normalizeNumberInRange } from "./number";
import { normalizeStringList } from "./string-list";
import { normalizeUuid } from "./uuid";

export const AGENT_INPUT_NORMALIZATION_KEY = "x-stella-agent-input";

export const AGENT_INPUT_NORMALIZATION_KIND = {
  boolean: "boolean",
  country: "country",
  date: "date",
  dateFormat: "date-format",
  eli: "eli",
  enum: "enum",
  filter: "filter",
  locale: "locale",
  number: "number",
  stringList: "string-list",
  uuid: "uuid",
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

type AgentInputAnnotationCommon = {
  /** Preserve invalid input only when the owning handler deliberately repairs it. */
  invalidValueDisposition?: "handler-owned";
  /** Locale context disambiguates numeric grouping and adds named date months. */
  locale?: string;
  /**
   * A `date` field that is one end of a range: a bare year or month then names
   * its first or last day, and an open-ended sentinel (`0001-01-01`,
   * `9999-12-31`) reads as no bound.
   */
  bound?: "start" | "end";
  /**
   * A `number` field whose range is a server limit rather than a meaning, such
   * as a page size: a value outside it is clamped with a note instead of
   * refused.
   */
  range?: "clamp";
};

/**
 * A kind, plus whatever that kind cannot be read without.
 *
 * `country` is a union branch rather than an optional property because it has
 * two canonical spellings and no default between them: a field declared
 * `{ kind: "country" }` alone would type-check and then have nothing to say
 * about which code to store.
 */
export type AgentInputNormalizationAnnotation =
  | (AgentInputAnnotationCommon & {
      kind: Exclude<
        AgentInputNormalizationKind,
        typeof AGENT_INPUT_NORMALIZATION_KIND.country
      >;
      country?: never;
    })
  | (AgentInputAnnotationCommon & {
      kind: typeof AGENT_INPUT_NORMALIZATION_KIND.country;
      country: AgentInputCountryAnnotation;
    });

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
      return annotation.bound === undefined
        ? "Use ISO YYYY-MM-DD; unambiguous localized calendar dates are normalized."
        : `Use ISO YYYY-MM-DD; a bare year or year-month reads as its ${annotation.bound === "start" ? "first" : "last"} day.`;
    case "date-format":
      return (
        'Use an object with a BCP-47 locale, such as {"locale":"en-GB","style":"short"}; ' +
        'an unambiguous combined string such as "en-GB-short" is normalized.'
      );
    case "eli":
      return "A short, prefix-less or reordered ELI is read as the canonical one.";
    case "enum":
      return "Use an advertised value; case and surrounding whitespace are normalized.";
    case "filter":
      return 'Omit it to search without this filter; a placeholder such as "all" or "-" reads as no filter.';
    case "locale":
      return 'Use a BCP-47 language tag, for example "cs" or "en-GB".';
    case "number":
      return annotation.range === "clamp"
        ? "Use a JSON number; a value outside the range is clamped to it."
        : "Use a JSON number; unambiguous localized numeric notation is normalized.";
    case "string-list":
      return "Use a JSON array of strings; a single string is read as a one-item list.";
    case "uuid":
      return "Use an id a previous call returned; a placeholder id such as all zeros reads as no value.";
    default:
      annotation satisfies never;
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
  const disposition =
    annotation["invalidValueDisposition"] === "handler-owned"
      ? "handler-owned"
      : undefined;
  const bound = annotation["bound"];
  const common: AgentInputAnnotationCommon = {
    ...(disposition === undefined
      ? {}
      : { invalidValueDisposition: disposition }),
    ...(typeof locale === "string" ? { locale } : {}),
    ...(bound === "start" || bound === "end" ? { bound } : {}),
    ...(annotation["range"] === "clamp" ? { range: "clamp" } : {}),
  };
  if (normalizedKind === AGENT_INPUT_NORMALIZATION_KIND.country) {
    const country = countryAnnotationOf(annotation["country"]);
    // A country annotation without a spelling says nothing about which code to
    // store, so it is not an annotation: the field falls through to whatever
    // its own schema says rather than being read as a country.
    return country === undefined
      ? undefined
      : { ...common, kind: normalizedKind, country };
  }
  return { ...common, kind: normalizedKind };
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
  if (schema["format"] === "uuid" && types.includes("string")) {
    return { kind: AGENT_INPUT_NORMALIZATION_KIND.uuid };
  }
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
  country,
  path,
  value,
}: {
  country: AgentInputCountryAnnotation;
  path: string;
  value: unknown;
}): Normalized<unknown> => {
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

/** Readers a kind cannot run without, supplied by the surface that owns the
 *  data: which publisher serves each ELI jurisdiction is the corpus's, not
 *  this package's. A kind whose reader is missing is left as sent. */
export type AgentInputReaders = {
  eli?: EliOptions;
};

const numericKeyword = (
  schema: Record<string, unknown>,
  keyword: "minimum" | "maximum",
): number | undefined => {
  const value = schema[keyword];
  return typeof value === "number" ? value : undefined;
};

const normalizeLeaf = ({
  annotation,
  path,
  readers,
  schema,
  value,
}: {
  annotation: AgentInputNormalizationAnnotation;
  /** Dotted path of the field, whose last segment is the property an ask names. */
  path: string;
  readers: AgentInputReaders;
  schema: Record<string, unknown>;
  value: unknown;
}): NormalizedOptional<unknown> | undefined => {
  switch (annotation.kind) {
    case "boolean":
      return normalizeBoolean(value);
    case "country":
      return normalizeCountryLeaf({ country: annotation.country, path, value });
    case "date": {
      const locales =
        annotation.locale === undefined ? undefined : [annotation.locale];
      return annotation.bound === undefined
        ? normalizeDateValue(
            value,
            locales === undefined ? undefined : { locales },
          )
        : normalizeDateBound(value, { bound: annotation.bound, locales });
    }
    case "date-format":
      return normalizeDateFormatSpec(value);
    case "eli":
      return readers.eli === undefined
        ? undefined
        : normalizeEli(value, readers.eli);
    case "enum":
      return normalizeEnumValue(value, stringEnumOf(schema) ?? []);
    case "filter":
      // A filter's own vocabulary is the handler's (it lives in the data), so
      // only the placeholder a caller writes for "not filtering" is read here.
      return isAbsentPlaceholder(value)
        ? readAsAbsent(value, "no filter")
        : { ok: true, value };
    case "locale":
      return normalizeLocale(value);
    case "number": {
      const locale = annotation.locale;
      if (annotation.range === "clamp") {
        const types = isUnknownArray(schema["type"])
          ? schema["type"]
          : [schema["type"]];
        return normalizeNumberInRange(value, {
          minimum: numericKeyword(schema, "minimum"),
          maximum: numericKeyword(schema, "maximum"),
          integer: types.includes("integer"),
          ...(locale === undefined ? {} : { locale }),
        });
      }
      return normalizeNumber(
        value,
        locale === undefined ? undefined : { locale },
      );
    }
    case "string-list":
      return normalizeStringList(value, { split: "never" });
    case "uuid":
      return normalizeUuid(value);
    default:
      annotation satisfies never;
      return panic("Unhandled agent input normalization kind");
  }
};

type WalkResult =
  | { status: "normalized"; value: unknown; notes: string[] }
  /** A placeholder: the property it sits in is read as not sent. */
  | { status: "absent"; received: string; note: string }
  | { status: "invalid"; issues: AgentInputNormalizationIssue[] }
  | { status: "not-applicable" };

/**
 * What a placeholder in an optional property means. On a read it is "not
 * filtering", so the property is dropped with a note. On a write an optional
 * id can switch what the call does (update this record, or create one), and a
 * placeholder there is an intent nobody stated, so it is asked about.
 */
export type AgentInputPlaceholderPolicy = "absent" | "ask";

type WalkContext = {
  placeholders: AgentInputPlaceholderPolicy;
  readers: AgentInputReaders;
  rootSchema: unknown;
  remainingReferenceDepth: number;
};

/**
 * A placeholder where a value is required is not an omission the caller may
 * make, so it is asked about rather than dropped: the call cannot mean
 * anything without the property.
 */
const placeholderIssue = (
  path: string,
  absent: Extract<WalkResult, { status: "absent" }>,
  presence: "required" | "optional",
): AgentInputNormalizationIssue => {
  const subject = path.length === 0 ? "This value" : `'${path}'`;
  return {
    path,
    received: absent.received,
    expected: "a real value",
    hint:
      presence === "required"
        ? `${subject} is required: pass a value a previous call returned, not a placeholder.`
        : `${subject} holds a placeholder: omit it, or pass a value a previous call returned.`,
  };
};

/** Whether an array schema holds strings, so a lone string can be its one item. */
const holdsStrings = (items: unknown): boolean => {
  if (!isRecord(items)) {
    return false;
  }
  const types = isUnknownArray(items["type"]) ? items["type"] : [items["type"]];
  return types.includes("string") || stringEnumOf(items) !== undefined;
};

/**
 * Whether a string list's items are constrained tokens (an id, a code, an
 * advertised value), which never carry a comma of their own, so a
 * comma-joined string is a list. Free text is never split.
 */
const holdsTokens = (items: unknown): boolean =>
  isRecord(items) &&
  (typeof items["format"] === "string" ||
    typeof items["pattern"] === "string" ||
    stringEnumOf(items) !== undefined);

const MAX_SCHEMA_REFERENCE_DEPTH = 64;

const valueMatchesType = (type: unknown, value: unknown): boolean => {
  switch (type) {
    case "array":
      // A lone string is read as a one-item list, so it may take this branch.
      return Array.isArray(value) || typeof value === "string";
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
    (
      result,
    ): result is Extract<WalkResult, { status: "normalized" | "absent" }> =>
      result.status === "normalized" || result.status === "absent",
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
    canonical.set(
      result.status === "absent" ? "absent" : JSON.stringify(result.value),
      result,
    );
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
    if (result.status === "absent") {
      return result;
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
  if (siblingResult.status === "invalid" || siblingResult.status === "absent") {
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
    const normalized = normalizeLeaf({
      annotation,
      path,
      readers: context.readers,
      schema,
      value,
    });
    if (normalized === undefined) {
      return { status: "not-applicable" };
    }
    if (normalized.ok === "absent") {
      return {
        status: "absent",
        received: normalized.received,
        note: normalized.note,
      };
    }
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
    return walkObject({ schema, value, path, context });
  }

  const items = schema["items"];
  return items === undefined
    ? { status: "not-applicable" }
    : walkList({ items, value, path, context });
};

/** The schemas one property of an object is read against, in order. */
const childSchemasOf = (
  schema: Record<string, unknown>,
  key: string,
): unknown[] => {
  const properties = schema["properties"];
  const patternProperties = schema["patternProperties"];
  const childSchemas: unknown[] = [];
  if (isRecord(properties) && key in properties) {
    childSchemas.push(properties[key]);
  }
  if (isRecord(patternProperties)) {
    for (const [pattern, childSchema] of Object.entries(patternProperties)) {
      if (new RegExp(pattern, "u").test(key)) {
        childSchemas.push(childSchema);
      }
    }
  }
  const additionalProperties = schema["additionalProperties"];
  if (childSchemas.length === 0 && isRecord(additionalProperties)) {
    childSchemas.push(additionalProperties);
  }
  return childSchemas;
};

/** One property's reading: a value, or a placeholder read as not sent. */
type PropertyReading =
  | { status: "value"; value: unknown }
  | { status: "absent" };

const walkObject = ({
  schema,
  value,
  path,
  context,
}: {
  schema: Record<string, unknown>;
  value: Record<string, unknown>;
  path: string;
  context: WalkContext;
}): WalkResult => {
  const output: Record<string, unknown> = {};
  const notes: string[] = [];
  const issues: AgentInputNormalizationIssue[] = [];
  const requiredKeys = schema["required"];
  const required: ReadonlySet<unknown> = new Set(
    isUnknownArray(requiredKeys) ? requiredKeys : [],
  );
  for (const [key, entry] of Object.entries(value)) {
    let reading: PropertyReading = { status: "value", value: entry };
    for (const childSchema of childSchemasOf(schema, key)) {
      if (reading.status === "absent") {
        break;
      }
      const child = walkSchema({
        schema: childSchema,
        value: reading.value,
        path: joinPath(path, key),
        context,
      });
      if (child.status === "invalid") {
        issues.push(...child.issues);
      } else if (child.status === "absent") {
        const presence = required.has(key) ? "required" : "optional";
        if (presence === "required" || context.placeholders === "ask") {
          issues.push(placeholderIssue(joinPath(path, key), child, presence));
        } else {
          reading = { status: "absent" };
          notes.push(child.note);
        }
      } else if (child.status === "normalized") {
        reading = { status: "value", value: child.value };
        notes.push(...child.notes);
      }
    }
    // A placeholder in an optional property is read as not sent, so the key
    // is left out of the output rather than carried with its placeholder.
    if (reading.status === "value") {
      output[key] = reading.value;
    }
  }
  return issues.length > 0
    ? { status: "invalid", issues }
    : { status: "normalized", value: output, notes };
};

const walkList = ({
  items,
  value,
  path,
  context,
}: {
  items: unknown;
  value: unknown;
  path: string;
  context: WalkContext;
}): WalkResult => {
  const notes: string[] = [];
  let list: unknown = value;
  if (typeof value === "string" && holdsStrings(items)) {
    // A model sends one value where the schema wants a list of them, or the
    // list joined into one string. The list reader owns which it was.
    const read = normalizeStringList(value, {
      split: holdsTokens(items) ? "delimiters" : "never",
    });
    if (!read.ok) {
      const { expected, hint, received } = read;
      return {
        status: "invalid",
        issues: [{ path, received, expected, hint }],
      };
    }
    list = read.value;
    if (read.note !== undefined) {
      notes.push(read.note);
    }
  }
  if (!isUnknownArray(list)) {
    return { status: "not-applicable" };
  }
  const output: unknown[] = [];
  const issues: AgentInputNormalizationIssue[] = [];
  for (const [index, entry] of list.entries()) {
    const child = walkSchema({
      schema: items,
      value: entry,
      path: joinPath(path, String(index)),
      context,
    });
    if (child.status === "invalid") {
      issues.push(...child.issues);
    } else if (child.status === "absent") {
      // A list has no optional slots: a placeholder item is asked about.
      issues.push(
        placeholderIssue(joinPath(path, String(index)), child, "required"),
      );
    } else if (child.status === "normalized") {
      notes.push(...child.notes);
    }
    output.push(child.status === "normalized" ? child.value : entry);
  }
  return issues.length > 0
    ? { status: "invalid", issues }
    : { status: "normalized", value: output, notes };
};

/**
 * Normalize one agent-written value from its canonical JSON Schema. Standard
 * `type`, `format: date`, and string `enum` keywords are the annotations for
 * numbers, booleans, dates, and closed vocabularies. The extension key handles
 * kinds JSON Schema cannot name, such as locales and date-format specs.
 */
export const normalizeAgentInput = ({
  path = "",
  placeholders = "absent",
  readers = {},
  schema,
  value,
}: {
  path?: string;
  /** What a placeholder in an optional property means; see the type. */
  placeholders?: AgentInputPlaceholderPolicy;
  readers?: AgentInputReaders;
  schema: unknown;
  value: unknown;
}): AgentInputNormalizationResult => {
  const result = walkSchema({
    schema,
    value,
    path,
    context: {
      placeholders,
      readers,
      rootSchema: schema,
      remainingReferenceDepth: MAX_SCHEMA_REFERENCE_DEPTH,
    },
  });
  if (result.status === "invalid") {
    return { ok: false, issues: result.issues };
  }
  if (result.status === "absent") {
    return { ok: true, value: undefined, notes: [result.note] };
  }
  return result.status === "normalized"
    ? { ok: true, value: result.value, notes: result.notes }
    : { ok: true, value, notes: [] };
};
