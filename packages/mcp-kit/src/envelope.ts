/**
 * How answers go on the wire: a success is its JSON payload, a failure is
 * `{ "error": { code, message, hint, retryable } }` with `isError` set, and
 * any "read X as Y" notes from lenient input reading ride after the payload
 * as their own text block, so the payload stays the tool's contract.
 */

import type {
  ToolCallResult,
  ToolError,
  ToolInputIssue,
  ToolOutcome,
} from "./types";

/** Error codes the surface itself answers with; a tool adds its own. */
export const KIT_ERROR_CODES = {
  validation: "validation_error",
  unknownTool: "unknown_tool",
  notFound: "not_found",
  internal: "internal_error",
} as const;

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
export const success = (value: unknown): ToolOutcome => ({ ok: true, value });

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

/** Encode an outcome as a `tools/call` result, with the input notes after a success. */
export const toCallResult = (
  outcome: ToolOutcome,
  notes: readonly string[] = [],
): ToolCallResult => {
  if (!outcome.ok) {
    return {
      content: [
        { type: "text", text: JSON.stringify({ error: outcome.error }) },
      ],
      isError: true,
    };
  }
  const content: ToolCallResult["content"] = [
    { type: "text", text: JSON.stringify(outcome.value ?? null) },
  ];
  const distinct = [...new Set(notes)];
  if (distinct.length > 0) {
    content.push({ type: "text", text: `Input read: ${distinct.join(" ")}` });
  }
  return { content, isError: false };
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
        a.distance - b.distance || a.candidate.localeCompare(b.candidate),
    )
    .slice(0, 3)
    .map(({ candidate }) => candidate);
};

/** Render nearby tool names as a corrective suggestion. */
export const didYouMean = (suggestions: readonly string[]): string =>
  suggestions.length === 0
    ? ""
    : `Did you mean ${suggestions.map((name) => `"${name}"`).join(" or ")}? `;
