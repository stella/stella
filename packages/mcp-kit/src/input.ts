/**
 * Reading a model's arguments before a tool sees them: `null` in an optional
 * property is absent, spellings that carry one meaning (`"true"`, `"20"`, an
 * enum value in another case) are read through `@stll/agent-input` with a
 * note, anything that carries two is asked about, and an argument the schema
 * does not declare, or a required one that is missing, is refused rather than
 * dropped.
 */

import { panic } from "better-result";

import {
  normalizeAgentInput,
  type AgentInputPlaceholderPolicy,
} from "@stll/agent-input";

import type { McpJsonSchema, ToolAccess, ToolInputIssue } from "./types";

/** Normalized arguments and notes, or actionable input issues. */
export type ReadInput =
  | { ok: true; value: Record<string, unknown>; notes: readonly string[] }
  | {
      ok: false;
      message: string;
      issues: readonly ToolInputIssue[];
      hint: string;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const UNSUPPORTED_ROOT_KEYWORDS = [
  "$ref",
  "$dynamicRef",
  "$recursiveRef",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependencies",
  "dependentSchemas",
  "patternProperties",
  "unevaluatedProperties",
] as const;

/**
 * Argument names must be declared directly on an object root. Composition and
 * references are supported within properties, but cannot supply root arguments.
 * A root without properties declares a zero-argument tool.
 */
export const assertToolInputSchema = (schema: McpJsonSchema): void => {
  if (schema["type"] !== "object") {
    panic("Tool input schema must have type object at its root.");
  }
  for (const keyword of UNSUPPORTED_ROOT_KEYWORDS) {
    if (Object.hasOwn(schema, keyword)) {
      panic(
        `Tool input schema does not support root ${keyword}; declare arguments in root properties.`,
      );
    }
  }
  const properties = schema["properties"];
  if (properties !== undefined && !isRecord(properties)) {
    panic("Tool input schema properties must be an object.");
  }
  const additionalProperties = schema["additionalProperties"];
  if (additionalProperties !== undefined && additionalProperties !== false) {
    panic(
      "Tool input schema cannot accept undeclared root arguments; additionalProperties must be false or omitted.",
    );
  }
  const required = schema["required"];
  if (required === undefined) {
    return;
  }
  if (
    !Array.isArray(required) ||
    !required.every((name) => typeof name === "string")
  ) {
    panic("Tool input schema required must be an array of argument names.");
  }
  if (
    required.some(
      (name) => !isRecord(properties) || !Object.hasOwn(properties, name),
    )
  ) {
    panic(
      "Tool input schema required arguments must be declared in root properties.",
    );
  }
};

const propertiesOf = (schema: McpJsonSchema): Record<string, unknown> =>
  isRecord(schema["properties"]) ? schema["properties"] : {};

const requiredOf = (schema: McpJsonSchema): string[] =>
  Array.isArray(schema["required"])
    ? schema["required"].filter((key): key is string => typeof key === "string")
    : [];

/**
 * A placeholder in an optional property of a read is "not filtering" and is
 * dropped with a note; on a write it may be an id that changes what the call
 * does, so it is asked about.
 */
const PLACEHOLDER_POLICY = {
  read: "absent",
  write: "ask",
} as const satisfies Record<ToolAccess, AgentInputPlaceholderPolicy>;

type ReadInputOptions = {
  schema: McpJsonSchema;
  value: unknown;
  access: ToolAccess;
  /** Properties passed through exactly as sent. */
  exactProperties?: readonly string[];
};

const refusal = (
  message: string,
  issues: ToolInputIssue[],
  hint: string,
): ReadInput => ({
  ok: false,
  message,
  issues,
  hint,
});

/** Check and leniently read one call's arguments against the tool's schema. */
export const readToolInput = ({
  schema,
  value,
  access,
  exactProperties = [],
}: ReadInputOptions): ReadInput => {
  assertToolInputSchema(schema);
  if (value !== undefined && !isRecord(value)) {
    return refusal(
      "Arguments must be a JSON object.",
      [],
      "Send the arguments as an object.",
    );
  }
  const properties = propertiesOf(schema);
  const required = requiredOf(schema);
  const input: Record<string, unknown> = {};
  const unknown: ToolInputIssue[] = [];
  for (const [key, entry] of Object.entries(value ?? {})) {
    if (entry === undefined) {
      continue;
    }
    if (!Object.hasOwn(properties, key)) {
      unknown.push({ path: key, message: `Unknown parameter: ${key}` });
    } else if (entry !== null || required.includes(key)) {
      Object.defineProperty(input, key, {
        value: entry,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  if (unknown.length > 0) {
    return refusal(
      "Arguments need clarification.",
      unknown,
      `Accepted parameters: ${Object.keys(properties).join(", ")}.`,
    );
  }

  const exact = new Set(exactProperties);
  const normalized = normalizeAgentInput({
    placeholders: PLACEHOLDER_POLICY[access],
    schema: {
      ...schema,
      properties: Object.fromEntries(
        Object.entries(properties).map(([key, property]) => [
          key,
          exact.has(key) ? {} : property,
        ]),
      ),
    },
    value: input,
  });
  if (!normalized.ok) {
    return refusal(
      "Arguments need clarification.",
      normalized.issues.map(({ path, received, expected }) => ({
        path,
        message: `${received} is not ${expected}.`,
      })),
      normalized.issues
        .map(({ path, hint }) =>
          path.length === 0 ? hint : `${path}: ${hint}`,
        )
        .join(" "),
    );
  }
  const read = isRecord(normalized.value) ? normalized.value : {};
  const missing = required
    .filter((key) => read[key] === undefined)
    .map((key) => ({ path: key, message: `Missing parameter: ${key}` }));
  if (missing.length > 0) {
    return refusal(
      "Arguments are incomplete.",
      missing,
      `Required: ${required.join(", ")}.`,
    );
  }
  return { ok: true, value: read, notes: normalized.notes };
};
