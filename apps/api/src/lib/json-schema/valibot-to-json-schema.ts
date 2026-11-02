import {
  type ConversionConfig,
  type JsonSchema,
  toJsonSchema as convertToJsonSchema,
} from "@valibot/to-json-schema";
import { type GenericSchema, safeParse } from "valibot";

import { API_DATE_RUNTIME_ONLY_CHECKS } from "@stll/api-contract/api-date";
import { DECISION_PARAGRAPH_RANGE_RUNTIME_ONLY_CHECKS } from "@stll/api-contract/decision-paragraph-range";
import { wireValueOf } from "@stll/api-contract/http-input";
import { keepUnicodePatternSource } from "@stll/api-contract/json-schema-regex";
import { UUID_RUNTIME_ONLY_ACTIONS } from "@stll/api-contract/uuid";
import { ANALYSIS_RUNTIME_ONLY_CHECKS } from "@stll/legal-ast/analysis";
import { DECISION_IDENTIFIER_RUNTIME_ONLY_CHECKS } from "@stll/legal-ast/decision-identifier";
import { DOCUMENT_AST_RUNTIME_ONLY_ACTIONS } from "@stll/legal-ast/document-ast";

import { isUniqueItemsCheck } from "@/api/lib/custom-schema";
import { isUnknownArray } from "@/api/lib/type-guards";

/** The `v.metadata` keys that are JSON Schema annotations. */
const JSON_SCHEMA_METADATA_KEYS = new Set(["title", "description", "examples"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Extension keywords (`x-maxUtf8Bytes`) a route schema publishes on purpose. */
const isExtensionKeyword = (key: string): boolean => key.startsWith("x-");

/**
 * `@valibot/to-json-schema` copies every `v.metadata` key onto the emitted
 * node. Our metadata also carries internal annotations (`chatProjection`),
 * which must not reach an MCP client, a model provider, or a published
 * contract, so only the keys JSON Schema defines survive, plus, for a route
 * schema, its `x-` extension keywords.
 */
const stripMetadataExcept =
  (
    published: (key: string) => boolean,
  ): NonNullable<ConversionConfig["overrideAction"]> =>
  ({ valibotAction, jsonSchema }) => {
    if (valibotAction.type !== "metadata" || !("metadata" in valibotAction)) {
      return undefined;
    }
    const { metadata } = valibotAction;
    if (!isRecord(metadata)) {
      return undefined;
    }
    const internalKeys = new Set(
      Object.keys(metadata).filter(
        (key) => !JSON_SCHEMA_METADATA_KEYS.has(key) && !published(key),
      ),
    );
    if (internalKeys.size === 0) {
      return undefined;
    }
    return Object.fromEntries(
      Object.entries(jsonSchema).filter(([key]) => !internalKeys.has(key)),
    );
  };

const stripInternalMetadata = stripMetadataExcept(() => false);
const stripRouteInternalMetadata = stripMetadataExcept(isExtensionKeyword);

/**
 * Actions, by identity, that their owners declare runtime-only: the
 * published node keeps every other action's keywords (bounds, pattern) and
 * the action still runs on every parse. Any other unsupported action stays
 * an error.
 */
const RUNTIME_ONLY_ACTIONS: ReadonlySet<unknown> = new Set([
  ...API_DATE_RUNTIME_ONLY_CHECKS,
  ...UUID_RUNTIME_ONLY_ACTIONS,
  ...ANALYSIS_RUNTIME_ONLY_CHECKS,
  ...DECISION_IDENTIFIER_RUNTIME_ONLY_CHECKS,
  ...DECISION_PARAGRAPH_RANGE_RUNTIME_ONLY_CHECKS,
  ...DOCUMENT_AST_RUNTIME_ONLY_ACTIONS,
]);

const RUNTIME_ONLY_CHECK_REQUIREMENTS: ReadonlySet<unknown> = new Set(
  [
    ...API_DATE_RUNTIME_ONLY_CHECKS,
    ...ANALYSIS_RUNTIME_ONLY_CHECKS,
    ...DECISION_IDENTIFIER_RUNTIME_ONLY_CHECKS,
    ...DECISION_PARAGRAPH_RANGE_RUNTIME_ONLY_CHECKS,
  ].map(({ requirement }) => requirement),
);

/** Whether a Valibot issue was raised by a check declared runtime-only. */
export const isRuntimeOnlyCheckIssue = (issue: {
  type: string;
  requirement?: unknown;
}): boolean =>
  issue.type === "check" &&
  RUNTIME_ONLY_CHECK_REQUIREMENTS.has(issue.requirement);

const keepRuntimeOnlyAction: NonNullable<
  ConversionConfig["overrideAction"]
> = ({ valibotAction, jsonSchema }) =>
  RUNTIME_ONLY_ACTIONS.has(valibotAction) ? jsonSchema : undefined;

/** A `uniqueItems` check is the keyword JSON Schema already has. */
const uniqueItemsAction: NonNullable<ConversionConfig["overrideAction"]> = ({
  valibotAction,
  jsonSchema,
}) =>
  isUniqueItemsCheck(valibotAction)
    ? { ...jsonSchema, uniqueItems: true }
    : undefined;

type ValibotJsonSchemaConfig = Omit<ConversionConfig, "overrideAction">;

export type { JsonSchema };

/** A valibot schema: route and tool schemas reach shared code as `unknown`. */
export const isValibotSchema = (value: unknown): value is GenericSchema =>
  isRecord(value) &&
  value["kind"] === "schema" &&
  isRecord(value["~standard"]) &&
  value["~standard"]["vendor"] === "valibot";

/** A schema node where JSON Schema allows `true`/`false` in place of one. */
export type JsonSchemaDefinition = JsonSchema | boolean;

/**
 * The only sanctioned Valibot to JSON Schema conversion in the API; a lint
 * rule bans importing the converter anywhere else.
 */
export const toJsonSchema = (
  schema: GenericSchema,
  config?: ValibotJsonSchemaConfig,
): JsonSchema =>
  convertToJsonSchema(schema, {
    ...config,
    overrideAction: (context) =>
      stripInternalMetadata(context) ??
      keepUnicodePatternSource(context) ??
      uniqueItemsAction(context) ??
      keepRuntimeOnlyAction(context),
  });

const WRAPPER_TYPES = new Set(["optional", "exact_optional", "nullish"]);

/**
 * A wrapper's default is written in the wire form its wire schema reads
 * (`"20"`); the client is shown the value that string decodes to (`20`).
 */
const wireDefault: NonNullable<ConversionConfig["overrideSchema"]> = ({
  valibotSchema,
  jsonSchema,
}) => {
  const wrapped =
    WRAPPER_TYPES.has(valibotSchema.type) && "wrapped" in valibotSchema
      ? valibotSchema.wrapped
      : undefined;
  const pipe = isRecord(wrapped) ? wrapped["pipe"] : undefined;
  if (
    !isUnknownArray(pipe) ||
    !pipe.some((item) => isRecord(item) && wireValueOf(item) !== undefined) ||
    !("default" in jsonSchema)
  ) {
    return undefined;
  }
  const decoded = safeParse(valibotSchema, jsonSchema.default);
  const value = decoded.success ? jsonScalars(decoded.output) : undefined;
  return value === undefined ? undefined : { ...jsonSchema, default: value };
};

/** File bytes in a multipart body render the way JSON Schema names binary. */
const binaryFile: NonNullable<ConversionConfig["overrideSchema"]> = ({
  valibotSchema,
}) =>
  valibotSchema.type === "file" || valibotSchema.type === "blob"
    ? { type: "string", format: "binary" }
    : undefined;

/**
 * A file's size cap. JSON Schema has no keyword for the byte length of binary
 * content, so the cap is published as an extension keyword.
 */
const fileSizeAction: NonNullable<ConversionConfig["overrideAction"]> = ({
  valibotAction,
  jsonSchema,
}) =>
  valibotAction.type === "max_size" &&
  "requirement" in valibotAction &&
  typeof valibotAction.requirement === "number"
    ? { ...jsonSchema, "x-maxBytes": valibotAction.requirement }
    : undefined;

/** A loose object passes undeclared keys through, which its rendering must say. */
const looseObject: NonNullable<ConversionConfig["overrideSchema"]> = ({
  valibotSchema,
  jsonSchema,
}) =>
  valibotSchema.type === "loose_object"
    ? { ...jsonSchema, additionalProperties: true }
    : undefined;

const LITERAL_JSON_TYPES = {
  string: "string",
  number: "number",
  boolean: "boolean",
} as const;

const isLiteralJsonType = (
  type: string,
): type is keyof typeof LITERAL_JSON_TYPES => type in LITERAL_JSON_TYPES;

/**
 * A literal states its type beside its `const`, so a client that reads a
 * union of literals as an enum (the generated CLI's flags) sees one.
 */
const typedLiteral: NonNullable<ConversionConfig["overrideSchema"]> = ({
  valibotSchema,
  jsonSchema,
}) => {
  if (valibotSchema.type !== "literal" || !("const" in jsonSchema)) {
    return undefined;
  }
  const type = typeof jsonSchema.const;
  return isLiteralJsonType(type)
    ? { ...jsonSchema, type: LITERAL_JSON_TYPES[type] }
    : undefined;
};

/** An object with no required property says nothing by listing none. */
const withoutEmptyRequired = (
  jsonSchema: JsonSchema,
): JsonSchema | undefined => {
  if (!isUnknownArray(jsonSchema.required) || jsonSchema.required.length > 0) {
    return undefined;
  }
  const { required: _none, ...rest } = jsonSchema;
  return rest;
};

type JsonScalar = string | number | boolean;

const isJsonScalar = (value: unknown): value is JsonScalar =>
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

/** A decoded wire value, when it is one JSON can state: a scalar or a list of them. */
const jsonScalars = (value: unknown): JsonScalar | JsonScalar[] | undefined => {
  if (isJsonScalar(value)) {
    return value;
  }
  return isUnknownArray(value) && value.every(isJsonScalar)
    ? [...value]
    : undefined;
};

/**
 * A route's request or response schema as JSON Schema: what a client that
 * sends values (an agent, the generated CLI) reads, and what the response
 * bounds walk. Route schemas are written for the wire, so this rendering is
 * lenient where `toJsonSchema` is strict: a wire string shows the value it
 * carries, a step JSON Schema cannot state (a transform, a custom check) is
 * left out of the rendering while it still runs on every request, and the
 * route's `x-` extension keywords are kept. Every bound the rendering shows is
 * one the route enforces.
 */
export const toRouteJsonSchema = (schema: GenericSchema): JsonSchema =>
  convertToJsonSchema(schema, {
    errorMode: "ignore",
    overrideSchema: (context) => {
      const node =
        wireDefault(context) ??
        binaryFile(context) ??
        looseObject(context) ??
        typedLiteral(context);
      return withoutEmptyRequired(node ?? context.jsonSchema) ?? node;
    },
    overrideAction: (context) => {
      const value = wireValueOf(context.valibotAction);
      if (value !== undefined) {
        // The carried value renders in place of this node, so it takes no
        // dialect of its own: `$schema` belongs to the document root only.
        const { $schema: _dialect, ...carried } = toRouteJsonSchema(value);
        return carried;
      }
      return (
        stripRouteInternalMetadata(context) ??
        keepUnicodePatternSource(context) ??
        uniqueItemsAction(context) ??
        fileSizeAction(context) ??
        keepRuntimeOnlyAction(context)
      );
    },
  });
