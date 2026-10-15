/**
 * The repair turn a structured answer gets when it does not match its schema.
 *
 * The model is shown its own answer and told exactly where it breaks the
 * schema: the path of each failing value and what the schema expected there.
 * It answers once more, and that answer passes the full schema or the run
 * fails as `output_invalid`. One round only: a repair never repairs a repair,
 * and nothing here fills in, converts or drops a value on the model's behalf.
 *
 * The issue list carries paths and expectations only, never the received
 * value: the outcome line is logged, and a received value is model output
 * that can quote the document.
 */

import type { ModelMessage } from "@tanstack/ai";
import type * as v from "valibot";

import { logger } from "@/api/lib/observability/logger";

/** More issues than this add length, not information, to the repair turn. */
const MAX_REPAIR_ISSUES = 20;

export type StructuredOutputIssue = {
  /** Dotted path to the failing value; `(root)` for the answer itself. */
  readonly path: string;
  /** What the schema expected there, as Valibot names it. */
  readonly expected: string;
  /** The Valibot issue type (`string`, `strict_object`, `min_length`, ...). */
  readonly type: string;
};

const issuePath = (issue: v.BaseIssue<unknown>): string => {
  const keys = (issue.path ?? []).map(({ key }) => String(key));
  return keys.length === 0 ? "(root)" : keys.join(".");
};

export const structuredOutputIssues = (
  issues: readonly v.BaseIssue<unknown>[],
): StructuredOutputIssue[] =>
  issues.slice(0, MAX_REPAIR_ISSUES).map((issue) => ({
    path: issuePath(issue),
    expected: issue.expected ?? issue.type,
    type: issue.type,
  }));

const repairInstruction = (issues: readonly StructuredOutputIssue[]): string =>
  [
    "Your previous answer does not match the required JSON schema.",
    "Fix exactly these problems and return the complete answer again as one JSON value that matches the schema.",
    "Keep every other value as it was. Do not invent facts to satisfy the schema.",
    "",
    ...issues.map(
      ({ path, expected, type }) => `- ${path}: expected ${expected} (${type})`,
    ),
  ].join("\n");

/**
 * The original conversation plus the invalid answer and the repair request,
 * for the same model. The caller re-guards the list before it is sent: the
 * answer is model output and may carry anything the model saw.
 */
export const structuredOutputRepairMessages = <TMessage>({
  messages,
  invalidOutput,
  issues,
}: {
  messages: readonly TMessage[];
  invalidOutput: unknown;
  issues: readonly StructuredOutputIssue[];
}): (TMessage | ModelMessage)[] => [
  ...messages,
  { role: "assistant", content: JSON.stringify(invalidOutput) },
  { role: "user", content: repairInstruction(issues) },
];

export const STRUCTURED_OUTPUT_RUNG = {
  NATIVE: "native",
  MODEL_REPAIR: "model_repair",
} as const;

type StructuredOutputRung =
  (typeof STRUCTURED_OUTPUT_RUNG)[keyof typeof STRUCTURED_OUTPUT_RUNG];

type StructuredOutputOutcome =
  | { type: "ok"; rung: StructuredOutputRung }
  | { type: "failed"; kind: "output_invalid" };

/**
 * One line per structured run that needed or tried a repair, so the repair
 * rate per model and per role is countable. A first-pass success is not
 * logged: it is the common case and the generation events already count it.
 */
export const reportStructuredOutputOutcome = ({
  outcome,
  issues,
  modelId,
  provider,
  role,
}: {
  outcome: StructuredOutputOutcome;
  issues: readonly StructuredOutputIssue[];
  modelId: string;
  provider: string;
  role: string;
}): void => {
  if (outcome.type === "ok" && outcome.rung === STRUCTURED_OUTPUT_RUNG.NATIVE) {
    return;
  }
  logger.info("ai.structured_output.outcome", {
    "ai.structured_output.result": outcome.type,
    "ai.structured_output.rung":
      outcome.type === "ok" ? outcome.rung : outcome.kind,
    "ai.structured_output.issue_count": issues.length,
    "ai.structured_output.issue_types": [
      ...new Set(issues.map(({ type }) => type)),
    ].join(","),
    "ai.model": modelId,
    "ai.provider": provider,
    "ai.role": role,
  });
};
