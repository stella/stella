import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "typed-decisions",
  capability:
    "Typed decisions: a choice from a closed set, a yes/no or a score, asked of a decision model",
  owner: [
    "apps/api/src/lib/workflow/decisions/decide.ts",
    "apps/api/src/lib/workflow/decisions/decision-model.ts",
    "apps/api/src/lib/workflow/decisions/system-one.ts",
    "apps/api/src/lib/workflow/decisions/openai-decisions.ts",
    "apps/api/src/lib/workflow/decisions/decision-policy.ts",
    "apps/api/src/lib/workflow/decisions/system-one-runtime.ts",
    "apps/api/src/lib/workflow/decisions/answer-questions.ts",
  ],
  summary:
    "A decision model answers typed questions about a state with probability " +
    "distributions; it generates nothing. `decide.ts` is the one entry: it " +
    "resolves the organization's model (or the instance's, or none), applies " +
    "the confidence floor, captures failures and logs every decision, and " +
    "returns a `Decision` the caller must narrow before reading, so a " +
    "deployment without a model takes the same path as an answer under the " +
    "floor. `decision-model.ts` owns which model answers for an org, " +
    "`system-one.ts` and `openai-decisions.ts` the wire contracts and retry, `system-one-runtime.ts` the " +
    "instance credential, and `answer-questions.ts` the translation of a table " +
    "column (select, date, int) into questions and back into the `Answer` the " +
    "generative path writes. A caller builds questions with the constructors in " +
    "`system-one.ts` and asks them through `decide`; it never holds a client.",
  enforcement: {
    kind: "import",
    specifiers: [
      "@/api/lib/workflow/decisions/system-one-runtime",
      "@/api/lib/workflow/decisions/system-one",
      "@/api/lib/workflow/decisions/openai-decisions",
    ],
    names: [
      "getSystemOneClient",
      "createSystemOneClient",
      "createOpenAIDecisionsClient",
    ],
    allowed: [
      {
        path: "apps/api/src/scripts/polarity-system-one-compare.ts",
        reason:
          "Measures the raw model against the corpus with a pinned client; the floor is what it calibrates, so it reads below `decide`.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
