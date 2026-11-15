import { Result } from "better-result";

import type { VerdictOutcome } from "@/api/lib/lists/verification/verdict-decider";
import { VERDICT_OUTCOMES } from "@/api/lib/lists/verification/verdict-decider";
import type { DecisionModel } from "@/api/lib/workflow/decisions/decision-model";
import { SystemOneError } from "@/api/lib/workflow/decisions/system-one";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type FakeVerdictModelOptions = {
  /** What it answers for every claim; `fail` answers with an HTTP error,
   *  `throw` rejects. */
  answer:
    | { choice: VerdictOutcome; confidence: number }
    | { type: "fail" }
    | { type: "throw" };
  model?: string;
};

/** The chosen outcome at `confidence`, the rest shared evenly. */
const distribution = (choice: VerdictOutcome, confidence: number) =>
  Object.fromEntries(
    VERDICT_OUTCOMES.map((outcome) => [
      outcome,
      outcome === choice
        ? confidence
        : (1 - confidence) / (VERDICT_OUTCOMES.length - 1),
    ]),
  );

/**
 * A decision model that never leaves the process: it records every request
 * and answers each claim question the same way.
 */
export const fakeVerdictDecisionModel = ({
  answer,
  model = "jev-1.14",
}: FakeVerdictModelOptions) => {
  const requests: { state: unknown; questionIds: string[] }[] = [];
  const client = asTestRaw<DecisionModel>({
    provider: "typesafe",
    model,
    keySource: "byok",
    ask: async ({
      state,
      questions,
    }: {
      state: unknown;
      questions: Record<string, unknown>;
    }) => {
      const questionIds = Object.keys(questions);
      requests.push({ state, questionIds });
      if ("type" in answer) {
        if (answer.type === "throw") {
          // A transport that rejects instead of answering with an error.
          throw new SystemOneError({
            kind: "network",
            message: "fixture transport crashed",
          });
        }
        return Result.err(
          new SystemOneError({
            kind: "http",
            status: 500,
            message: "TypeSafe responded with HTTP 500",
          }),
        );
      }
      return await Promise.resolve(
        Result.ok({
          model,
          answers: Object.fromEntries(
            questionIds.map((id) => [
              id,
              {
                type: "choice",
                choice: answer.choice,
                probabilities: distribution(answer.choice, answer.confidence),
                confidence: answer.confidence,
              },
            ]),
          ),
          usage: { inputTokens: 120, outputTokens: 0 },
          latencyMs: 1,
        }),
      );
    },
  });
  return { client, requests };
};
