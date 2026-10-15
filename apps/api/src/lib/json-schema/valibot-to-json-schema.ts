import {
  type ConversionConfig,
  toJsonSchema as convertToJsonSchema,
  type JsonSchema,
} from "@valibot/to-json-schema";
import type { GenericSchema } from "valibot";

import { DECISION_PARAGRAPH_RANGE_RUNTIME_ONLY_CHECKS } from "@stll/api-contract/decision-paragraph-range";
import { keepUnicodePatternSource } from "@stll/api-contract/json-schema-regex";
import { DECISION_IDENTIFIER_RUNTIME_ONLY_CHECKS } from "@stll/legal-ast/decision-identifier";
import { DOCUMENT_AST_RUNTIME_ONLY_ACTIONS } from "@stll/legal-ast/document-ast";

/** The `v.metadata` keys that are JSON Schema annotations. */
const JSON_SCHEMA_METADATA_KEYS = new Set(["title", "description", "examples"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `@valibot/to-json-schema` copies every `v.metadata` key onto the emitted
 * node. Our metadata also carries internal annotations (`chatProjection`),
 * which must not reach an MCP client, a model provider, or a published
 * contract, so only the keys JSON Schema defines survive.
 */
const stripInternalMetadata: NonNullable<
  ConversionConfig["overrideAction"]
> = ({ valibotAction, jsonSchema }) => {
  if (valibotAction.type !== "metadata" || !("metadata" in valibotAction)) {
    return undefined;
  }
  const { metadata } = valibotAction;
  if (!isRecord(metadata)) {
    return undefined;
  }
  const internalKeys = new Set(
    Object.keys(metadata).filter((key) => !JSON_SCHEMA_METADATA_KEYS.has(key)),
  );
  if (internalKeys.size === 0) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(jsonSchema).filter(([key]) => !internalKeys.has(key)),
  );
};

/**
 * Actions, by identity, that their owners declare runtime-only: the
 * published node keeps every other action's keywords (bounds, pattern) and
 * the action still runs on every parse. Any other unsupported action stays
 * an error.
 */
const RUNTIME_ONLY_ACTIONS: ReadonlySet<unknown> = new Set([
  ...DECISION_IDENTIFIER_RUNTIME_ONLY_CHECKS,
  ...DECISION_PARAGRAPH_RANGE_RUNTIME_ONLY_CHECKS,
  ...DOCUMENT_AST_RUNTIME_ONLY_ACTIONS,
]);

const RUNTIME_ONLY_CHECK_REQUIREMENTS: ReadonlySet<unknown> = new Set(
  [
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

type ValibotJsonSchemaConfig = Omit<ConversionConfig, "overrideAction">;

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
      keepRuntimeOnlyAction(context),
  });
