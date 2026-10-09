import { panic, Result } from "better-result";
/**
 * How answers go on the wire: a success is its JSON payload, a failure is
 * `{ "error": { code, message, hint, retryable } }` with `isError` set, and
 * any "read X as Y" notes from lenient input reading ride after the payload
 * as their own text block, so the payload stays the tool's contract.
 */

import { compareByLocale } from "@stll/collation";

import type {
  McpJsonValue,
  ToolCallResult,
  ToolError,
  ToolInputIssue,
  ToolOutcome,
} from "./types";

const compareEnglish = compareByLocale("en");

/** Error codes the surface itself answers with; a tool adds its own. */
export const KIT_ERROR_CODES = {
  validation: "validation_error",
  unknownTool: "unknown_tool",
  notFound: "not_found",
  internal: "internal_error",
} as const;

/** Stable caller-facing message; hosts can observe the original failure separately. */
export const KIT_INTERNAL_MESSAGE = "The tool could not complete the request.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Shared references are allowed; ancestor cycles and lossy JSON conversions are not. */
const isMcpJsonValue = (
  value: unknown,
  ancestors = new Set<unknown>(),
): value is McpJsonValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (!Array.isArray(value) && !isRecord(value)) {
    return false;
  }
  if (ancestors.has(value)) {
    return false;
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return false;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) =>
        descriptor.get !== undefined || descriptor.set !== undefined,
    )
  ) {
    return false;
  }
  if (typeof descriptors["toJSON"]?.value === "function") {
    return false;
  }
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    return false;
  }
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? Array.from(value).every((entry) => isMcpJsonValue(entry, ancestors))
    : Object.values(value).every((entry) => isMcpJsonValue(entry, ancestors));
  ancestors.delete(value);
  return valid;
};

/** Construct a structured error, defaulting retryability to false. */
export const toolError = (error: {
  code: string;
  message: string;
  hint?: string | undefined;
  retryable?: boolean | undefined;
  issues?: readonly ToolInputIssue[] | undefined;
  details?: unknown;
}): ToolError => ({
  code: error.code,
  message: error.message,
  ...(error.hint !== undefined && { hint: error.hint }),
  retryable: error.retryable ?? false,
  ...(error.issues !== undefined &&
    error.issues.length > 0 && { issues: error.issues }),
  ...(error.details !== undefined && { details: error.details }),
});

/** Construct a failed handler outcome from structured error fields. */
export const failure = (
  error: Parameters<typeof toolError>[0],
): ToolOutcome => ({
  ok: false,
  error: toolError(error),
});

/** Construct a successful handler outcome containing a JSON payload. */
export const success = (value: McpJsonValue): ToolOutcome => ({
  ok: true,
  value,
});

/** Internal boundary for discovery DTOs whose schema fields are typed unknown. */
export const jsonSuccess = (value: unknown): ToolOutcome => {
  const checked = Result.try(() =>
    isMcpJsonValue(value)
      ? success(value)
      : failure({
          code: KIT_ERROR_CODES.internal,
          message: KIT_INTERNAL_MESSAGE,
        }),
  );
  return checked.isOk()
    ? checked.value
    : failure({
        code: KIT_ERROR_CODES.internal,
        message: KIT_INTERNAL_MESSAGE,
      });
};

/** Construct a retryable validation failure with input issues and recovery guidance. */
export const validationError = (
  message: string,
  issues: readonly ToolInputIssue[],
  hint?: string,
): ToolOutcome =>
  failure({
    code: KIT_ERROR_CODES.validation,
    message,
    issues,
    hint,
    retryable: true,
  });

/** Encode an outcome, reporting serialization failures to the host without exposing their cause. */
export const toCallResult = (
  outcome: ToolOutcome,
  notes: readonly string[] = [],
  onSerializationError?: (cause: unknown) => undefined,
): ToolCallResult => {
  const serialized = Result.try(() => {
    const value = outcome.ok ? outcome.value : { error: outcome.error };
    if (!isMcpJsonValue(value)) {
      panic("Tool result is not a JSON value.");
    }
    return JSON.stringify(value);
  });
  if (serialized.isErr()) {
    if (onSerializationError !== undefined) {
      // Observer failures must preserve the original structured tool failure.
      Result.try(() => onSerializationError(serialized.error)).unwrapOr(
        undefined,
      );
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: KIT_ERROR_CODES.internal,
              message: KIT_INTERNAL_MESSAGE,
              retryable: false,
            },
          }),
        },
      ],
      isError: true,
    };
  }
  const content: ToolCallResult["content"] = [
    { type: "text", text: serialized.value },
  ];
  const distinct = [...new Set(notes)];
  if (outcome.ok && distinct.length > 0) {
    content.push({ type: "text", text: `Input read: ${distinct.join(" ")}` });
  }
  return { content, isError: !outcome.ok };
};

const editDistance = (a: string, b: string): number => {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution =
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        substitution,
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
};

/** Up to three known names close to `name`, closest first. */
export const closestNames = (
  name: string,
  known: readonly string[],
): string[] => {
  const lowered = name.toLowerCase();
  return known
    .map((candidate) => {
      const lower = candidate.toLowerCase();
      const contains = lower.includes(lowered) || lowered.includes(lower);
      return {
        candidate,
        distance: contains ? 0 : editDistance(lowered, lower),
      };
    })
    .filter(
      ({ distance }) => distance <= Math.max(2, Math.floor(name.length / 3)),
    )
    .toSorted(
      (a, b) =>
        a.distance - b.distance || compareEnglish(a.candidate, b.candidate),
    )
    .slice(0, 3)
    .map(({ candidate }) => candidate);
};

/** Render nearby tool names as a corrective suggestion. */
export const didYouMean = (suggestions: readonly string[]): string =>
  suggestions.length === 0
    ? ""
    : `Did you mean ${suggestions.map((name) => `"${name}"`).join(" or ")}? `;
