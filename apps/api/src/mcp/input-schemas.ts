import { panic } from "better-result";
import * as v from "valibot";

import type {
  AgentInputNormalizationAnnotation,
  CountrySpelling,
} from "@stll/agent-input";
import {
  AGENT_INPUT_NORMALIZATION_KIND,
  COUNTRY_INPUT_MAX_CHARS,
} from "@stll/agent-input";

import { LIMITS } from "@/api/lib/limits";
import { isIssuablePaginationCursor } from "@/api/lib/pagination";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

/** Share the declared map shape across wire and parser contracts. */
export const plainRecord = <TValue extends v.GenericSchema>(value: TValue) => {
  const record = v.record(v.string(), value);
  const guarded = v.pipe(
    v.custom<Record<string, unknown>>(isRecord, "Expected an object"),
    record,
  );
  return {
    ...record,
    "~run": guarded["~run"],
    "~standard": guarded["~standard"],
    "~types": guarded["~types"],
  };
};

export const MAX_SEARCH_LIMIT = LIMITS.mcpSearchPageSizeMax;
export const ISO_DATE_SCHEMA = v.pipe(v.string(), v.isoDate());

/**
 * A UUID-shaped id input. Ids reach SQL as uuid columns, so a malformed one
 * must fail here as a validation error naming the field rather than as a
 * database cast failure reported as an internal error.
 */
export const uuidInputSchema = (description: string) =>
  v.pipe(v.string(), v.uuid(), v.description(description));

/**
 * A country input, in any spelling that carries one meaning.
 *
 * The leniency itself is not here: it is the `country` agent-input kind, which
 * the tool binds to this property with `countryNormalization` so one reader
 * canonicalizes every surface. This schema is the declaration that says a
 * country is what the property holds, and its bounds are what make the
 * advertised contract match that: a schema capped at three characters tells a
 * model the names are refused when the reader in fact reads them.
 */
export const countryInputSchema = (description: string) =>
  v.pipe(
    v.string(),
    v.maxLength(COUNTRY_INPUT_MAX_CHARS),
    v.description(description),
  );

/**
 * Binds a country property to the shared reader.
 *
 * `spelling` is required rather than defaulted: alpha-3 is what the corpus
 * keys on and alpha-2 is what a practice-jurisdiction row holds, and guessing
 * would write one into the other's column.
 */
export const countryNormalization = ({
  spelling,
  admitted,
  tool,
}: {
  spelling: CountrySpelling;
  admitted?: readonly string[];
  tool?: string;
}): AgentInputNormalizationAnnotation => ({
  kind: AGENT_INPUT_NORMALIZATION_KIND.country,
  country: {
    spelling,
    ...(admitted === undefined ? {} : { admitted }),
    ...(tool === undefined ? {} : { tool }),
  },
});

/**
 * An optional search filter whose values live in the corpus rather than in the
 * schema (a court, a decision type, a language). The shared reader drops the
 * placeholder a caller writes for "not filtering" (`" "`, `"all"`, `"-"`);
 * matching the value against the data is the handler's.
 */
export const FILTER_NORMALIZATION: AgentInputNormalizationAnnotation = {
  kind: AGENT_INPUT_NORMALIZATION_KIND.filter,
};

/** A statute's ELI, read back from the short and reordered spellings. */
export const ELI_NORMALIZATION: AgentInputNormalizationAnnotation = {
  kind: AGENT_INPUT_NORMALIZATION_KIND.eli,
};

/**
 * An MCP tool's declared input: `v.strictObject(...)`, or a pipe over one.
 * `entries` names every property the surface declares.
 */
type ToolObjectInputSchema = v.GenericSchema & {
  readonly entries: v.ObjectEntries;
};

/**
 * What a handler parses: the declared object with a strict client's nulls
 * already dropped. The declared object stays reachable as `advertisedSchema`
 * because JSON Schema projection reads a pipe's first schema, which here is
 * the `unknown` root the transform needs.
 */
export type NullAsAbsentInputSchema = v.GenericSchema & {
  readonly advertisedSchema: ToolObjectInputSchema;
};

/**
 * The wrapper's type for one declared object. Written out rather than inferred
 * from the `v.pipe(...)` expression: every tool input schema in this directory
 * goes through {@link nullAsAbsent}, so an inferred `SchemaWithPipe` over a
 * three-item tuple would be instantiated at each of them and carried into every
 * handler that reads `parsed.output`. This says the same thing in two nodes.
 */
type NullAsAbsentSchema<TSchema extends ToolObjectInputSchema> =
  v.GenericSchema<unknown, v.InferOutput<TSchema>> & {
    readonly advertisedSchema: TSchema;
  };

/**
 * The values a client sends for a property it is not setting. `null` is the
 * convention this surface documents; a client that must fill every declared
 * property instead sends the empty value of the declared type. `0` and `false`
 * are absent from this list on purpose: they are values a number or boolean
 * property means.
 */
const ABSENT_PLACEHOLDERS = [
  "null",
  "empty-string",
  "empty-array",
  "empty-object",
] as const;

type AbsentPlaceholder = (typeof ABSENT_PLACEHOLDERS)[number];

/** The value each placeholder stands for, for probing a property's schema. */
const PLACEHOLDER_VALUES = {
  null: null,
  "empty-string": "",
  "empty-array": [],
  "empty-object": {},
} as const satisfies Record<AbsentPlaceholder, unknown>;

const isPlaceholder = (value: unknown, placeholder: AbsentPlaceholder) => {
  switch (placeholder) {
    case "null":
      return value === null;
    case "empty-string":
      return value === "";
    case "empty-array":
      return isUnknownArray(value) && value.length === 0;
    case "empty-object":
      return (
        isRecord(value) &&
        !isUnknownArray(value) &&
        Object.keys(value).length === 0
      );
    default:
      return panic(`Unhandled absent placeholder: ${String(placeholder)}`);
  }
};

/** One object or array level of a declared input, as far as placeholder
 * dropping cares: which placeholders each property carries as absence, and
 * where to recurse. */
type NullAsAbsentPlan =
  | {
      readonly kind: "object";
      readonly absentWhen: ReadonlyMap<string, readonly AbsentPlaceholder[]>;
      readonly properties: ReadonlyMap<string, NullAsAbsentPlan>;
    }
  | { readonly kind: "array"; readonly item: NullAsAbsentPlan };

const isObjectSchema = (
  schema: unknown,
): schema is { entries: Record<string, v.GenericSchema> } =>
  isRecord(schema) && isRecord(schema["entries"]);

const isArraySchema = (schema: unknown): schema is { item: v.GenericSchema } =>
  isRecord(schema) && isRecord(schema["item"]);

/** Strip `optional`/`nullable`/... wrappers and pipes down to the schema that
 * declares the shape. */
const declaredShapeOf = (schema: unknown): unknown => {
  if (!isRecord(schema)) {
    return schema;
  }
  const pipe = schema["pipe"];
  if (isUnknownArray(pipe) && pipe.length > 0) {
    return declaredShapeOf(pipe[0]);
  }
  const wrapped = schema["wrapped"];
  return wrapped === undefined ? schema : declaredShapeOf(wrapped);
};

/**
 * The placeholders one property carries as absence: those it REJECTS, on a
 * property that accepts being omitted. A required property still fails on the
 * placeholder, and a property that accepts it keeps it — an empty string on a
 * plain text property is an empty label, not an omission.
 */
const absentPlaceholdersOf = (schema: v.GenericSchema): AbsentPlaceholder[] => {
  if (!v.safeParse(schema, undefined).success) {
    return [];
  }
  return ABSENT_PLACEHOLDERS.filter(
    (placeholder) =>
      !v.safeParse(schema, PLACEHOLDER_VALUES[placeholder]).success,
  );
};

const nullAsAbsentPlan = (schema: unknown): NullAsAbsentPlan | undefined => {
  const declared = declaredShapeOf(schema);
  if (isObjectSchema(declared)) {
    const absentWhen = new Map<string, readonly AbsentPlaceholder[]>();
    const properties = new Map<string, NullAsAbsentPlan>();
    for (const [key, property] of Object.entries(declared.entries)) {
      const placeholders = absentPlaceholdersOf(property);
      if (placeholders.length > 0) {
        absentWhen.set(key, placeholders);
      }
      const nested = nullAsAbsentPlan(property);
      if (nested !== undefined) {
        properties.set(key, nested);
      }
    }
    return { kind: "object", absentWhen, properties };
  }
  if (!isArraySchema(declared)) {
    return undefined;
  }
  const item = nullAsAbsentPlan(declared.item);
  return item === undefined ? undefined : { kind: "array", item };
};

const applyNullAsAbsent = (value: unknown, plan: NullAsAbsentPlan): unknown => {
  switch (plan.kind) {
    case "array":
      return isUnknownArray(value)
        ? value.map((entry) => applyNullAsAbsent(entry, plan.item))
        : value;
    case "object": {
      if (!isRecord(value)) {
        return value;
      }
      return Object.fromEntries(
        Object.entries(value).flatMap(([key, entry]) => {
          const placeholders = plan.absentWhen.get(key);
          if (
            placeholders?.some((placeholder) =>
              isPlaceholder(entry, placeholder),
            )
          ) {
            return [];
          }
          const nested = plan.properties.get(key);
          return [
            [
              key,
              nested === undefined ? entry : applyNullAsAbsent(entry, nested),
            ] as const,
          ];
        }),
      );
    }
    default:
      return panic(`Unhandled null-as-absent plan: ${JSON.stringify(plan)}`);
  }
};

/**
 * Read a tool's input with a placeholder meaning absence, at every object level
 * the schema declares.
 *
 * A strict tool-schema client must send every declared property, so it sends
 * something for the ones it is not setting: `null`, or — the shape models
 * actually produce — the empty value of the declared type, `""` for a string,
 * `[]` for an array, `{}` for an object. None of those is a value on this
 * surface: `input_type: null` reads as a field with no input control,
 * `options_from: ""` as a dependent select sourced from a field with no path.
 * Normalizing inside one handler leaves every other consumer of the schema
 * (evals, tests, the capability catalog) with the raw contract, so the schema
 * owns it instead.
 *
 * Only a placeholder the property ITSELF rejects is dropped, and only on a
 * property that accepts being omitted. A required property set to a
 * placeholder, a placeholder under a misspelled key, and an empty string on a
 * property that accepts one all still read exactly as sent. `0` and `false`
 * are never placeholders.
 */
export const nullAsAbsent = <TSchema extends ToolObjectInputSchema>(
  advertisedSchema: TSchema,
): NullAsAbsentSchema<TSchema> => {
  const plan =
    nullAsAbsentPlan(advertisedSchema) ??
    panic("A tool input schema must declare object properties");
  return Object.assign(
    v.pipe(
      v.unknown(),
      v.transform((value: unknown) => applyNullAsAbsent(value, plan)),
      advertisedSchema,
    ),
    { advertisedSchema },
  );
};

/** Wire cap on an opaque pagination cursor, shared with the tool schemas. */
const MAX_CURSOR_LENGTH = 512;

type CursorInputOptions = {
  description: string;
  maxLength?: number;
  /**
   * Which strings the encoder behind this property can have issued. Defaults
   * to the shared codecs' class. A surface paginated by something else (an
   * upstream decimal offset) passes its own, because reading its cursors
   * against the shared class would call every one of them made up.
   */
  issuedBy?: (value: string) => boolean;
};

/**
 * A pagination cursor property, with a made-up value read as absence.
 *
 * A client that fills every declared property has to put something in
 * `cursor` on its first call, and what it puts there is a placeholder: `" "`,
 * `"0"`, `"start"`, `"__start__"`. Handing those to a decoder answers
 * `Invalid cursor` to a caller holding no cursor, so it invents another one
 * and the call never reaches a first page. A value outside the issued class
 * therefore means "no cursor", exactly as `null` and `""` do through
 * {@link nullAsAbsent}.
 *
 * A value inside the class still goes to the tool's own decoder and still
 * fails there when it does not decode: a truncated real cursor decodes to a
 * readable prefix, and silently restarting that caller at page one would
 * repeat a page it had already read.
 */
export const cursorInput = ({
  description,
  issuedBy = isIssuablePaginationCursor,
  maxLength = MAX_CURSOR_LENGTH,
}: CursorInputOptions) =>
  v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(maxLength),
      v.description(description),
      v.transform((value: string) => (issuedBy(value) ? value : undefined)),
    ),
  );
