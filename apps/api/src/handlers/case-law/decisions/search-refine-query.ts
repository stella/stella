import { Result } from "better-result";
import * as v from "valibot";

import {
  formatCorpusQueryTokens,
  partitionCorpusFunctionWords,
  tokenizeCorpusFreeText,
} from "@/api/lib/legal-search/corpus-query";
import { LIMITS } from "@/api/lib/limits";

/**
 * Words a refined case-law query may require. Every word the corpus query
 * carries is AND-ed, so each one past the few that name the issue only
 * narrows the result set; a model listing synonyms side by side would empty
 * it.
 */
export const CASE_LAW_REFINE_MAX_TERMS = 5;

/**
 * Spellings of the workspace search's boolean operators. The corpus query has
 * no operators: the tokenizer reads these as ordinary words and the clause
 * would require a decision to contain the word "OR".
 */
const BOOLEAN_OPERATOR_WORDS = new Set(["AND", "OR", "NOT"]);

export const caseLawRefineOutputSchema = v.strictObject({
  query: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(LIMITS.searchQueryMaxLength),
  ),
});

export const CASE_LAW_SEARCH_REFINE_SYSTEM = `You rewrite a reader's case-law search into the words court decisions use.

The search runs over court decisions of one jurisdiction. Every word you return is required: the words are AND-ed, and there are no operators, wildcards or grouping.

Rules:
- Use the terms the statutes and courts of that jurisdiction use, not everyday words.
- Write in corpusLanguage whatever language the reader used. If corpusLanguage is null, keep the reader's language.
- Drop question words, filler and anything the decisions would not literally contain.
- Return two to four words. Each extra word narrows the results, so never list synonyms or variants side by side; inflection is already handled.
- Do not add facts, parties, dates or courts the reader did not ask about.
- Plain words only: no quotes, operators or punctuation.

Example (CZE, cs): "Jak dlouho má pronajímatel na vrácení kauce?" becomes: vrácení jistoty pronajímatel`;

/**
 * The model's query as the corpus will read it, or why it cannot be used.
 *
 * Read through the same tokenizer and function-word partition the search
 * applies, so what is returned is exactly the words the search will require:
 * an answer the search would reduce to nothing, or to more words than
 * {@link CASE_LAW_REFINE_MAX_TERMS}, is rejected here rather than shown to
 * the reader as a query that finds nothing. The reason is written for the
 * model's next attempt.
 */
export const normalizeCaseLawRefinedQuery = (
  text: string,
  functionWords: ReadonlySet<string> | null,
): Result<string, string> => {
  const tokens = tokenizeCorpusFreeText(text);
  const operator = tokens.find(
    (token) => token.type === "term" && BOOLEAN_OPERATOR_WORDS.has(token.value),
  );
  if (operator !== undefined) {
    return Result.err(
      `"${operator.value}" is not an operator here; it would be required as a word. Return plain words only.`,
    );
  }
  const { required } = partitionCorpusFunctionWords(tokens, functionWords);
  if (required.length === 0) {
    return Result.err("The query has no searchable word.");
  }
  if (required.length > CASE_LAW_REFINE_MAX_TERMS) {
    return Result.err(
      `The query requires ${String(required.length)} words; every word is required, so return at most ${String(CASE_LAW_REFINE_MAX_TERMS)}.`,
    );
  }
  return Result.ok(formatCorpusQueryTokens(required));
};
