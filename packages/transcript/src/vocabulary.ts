import { panic, Result, TaggedError } from "better-result";

import { foldSearchMatchText } from "@stll/text-normalize";

export type VocabularyKind =
  | "matter-name"
  | "party"
  | "person"
  | "organization"
  | "case-number"
  | "court"
  | "document-title"
  | "statute"
  | "decision"
  | "glossary";

export type VocabularyCandidate = {
  term: string;
  kind: VocabularyKind;
  weight: number;
  /** Epoch milliseconds; used only to break equal-weight ties. */
  lastUsedAt?: number;
};

export type VocabularyMechanism =
  "none" | "groq-prompt" | "azure-phrase-list" | "context-hint";

type VocabularyBudget = { countLimit: number; tokenLimit: number };

/** Application budgets, measured with estimateVocabularyTokens, not a provider tokenizer. */
export const VOCABULARY_BUDGETS = {
  none: { countLimit: 0, tokenLimit: 0 },
  "groq-prompt": { countLimit: 100, tokenLimit: 200 },
  "azure-phrase-list": { countLimit: 500, tokenLimit: 4000 },
  "context-hint": { countLimit: 100, tokenLimit: 200 },
} as const satisfies Record<VocabularyMechanism, VocabularyBudget>;

export class VocabularyInputError extends TaggedError("VocabularyInputError")<{
  message: string;
  candidateIndex: number;
}> {}

type VocabularySelectionBase = {
  terms: string[];
  estimatedTokens: number;
};

export type VocabularySelection = VocabularySelectionBase &
  (
    | { mechanism: "none" | "azure-phrase-list" }
    | { mechanism: "groq-prompt" | "context-hint"; prompt: string }
  );

/** Three Unicode scalars per approximate token; separators count toward the budget. */
export const estimateVocabularyTokens = (text: string): number =>
  Math.ceil(Array.from(text).length / 3);

type BudgetVocabularyOptions = {
  candidates: readonly VocabularyCandidate[];
  mechanism: VocabularyMechanism;
};

export const budgetVocabulary = ({
  candidates,
  mechanism,
}: BudgetVocabularyOptions): Result<
  VocabularySelection,
  VocabularyInputError
> => {
  for (const [candidateIndex, candidate] of candidates.entries()) {
    if (
      candidate.term.trim().length === 0 ||
      !Number.isFinite(candidate.weight) ||
      (candidate.lastUsedAt !== undefined &&
        (!Number.isSafeInteger(candidate.lastUsedAt) ||
          candidate.lastUsedAt < 0))
    ) {
      return Result.err(
        new VocabularyInputError({
          message:
            "Vocabulary terms require nonempty text, finite weight, and a nonnegative integer timestamp",
          candidateIndex,
        }),
      );
    }
  }

  const ranked = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (left, right) =>
        right.candidate.weight - left.candidate.weight ||
        (right.candidate.lastUsedAt ?? 0) - (left.candidate.lastUsedAt ?? 0) ||
        left.index - right.index,
    );
  const { countLimit, tokenLimit } = VOCABULARY_BUDGETS[mechanism];
  const seen = new Set<string>();
  const terms: string[] = [];
  let scalarCount = 0;
  for (const { candidate } of ranked) {
    if (terms.length >= countLimit) {
      break;
    }
    const term = candidate.term.trim().replaceAll(/\s+/gu, " ");
    const key = foldSearchMatchText(term);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const nextScalarCount =
      scalarCount + Array.from(term).length + (terms.length > 0 ? 2 : 0);
    if (Math.ceil(nextScalarCount / 3) > tokenLimit) {
      continue;
    }
    terms.push(term);
    scalarCount = nextScalarCount;
  }
  const estimatedTokens = Math.ceil(scalarCount / 3);
  switch (mechanism) {
    case "none":
    case "azure-phrase-list":
      return Result.ok({ mechanism, terms, estimatedTokens });
    case "groq-prompt":
    case "context-hint":
      return Result.ok({
        mechanism,
        terms,
        estimatedTokens,
        prompt: terms.join(", "),
      });
    default:
      mechanism satisfies never;
      return panic("Unhandled vocabulary mechanism");
  }
};
