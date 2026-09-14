/**
 * A built-in default is a party-identification clause, and a party clause has
 * optional particulars: a company with no share capital on file must not
 * produce "kapitał zakładowy" followed by nothing.
 *
 * A default is therefore declared as an ordered list of clauses, each naming
 * the tokens it needs. The default *string* offered to an author and the
 * *rendering* for a particular hit are both derived from that one list — the
 * string by concatenating every clause, the rendering by dropping the clauses
 * whose particulars the hit lacks. Neither can drift from the other, because
 * neither is written down twice.
 */
export type RegistryFormatClause = {
  /** Clause text, including its own `[token]` slots. */
  readonly template: string;
  /**
   * Tokens that must resolve non-empty for the clause to appear. A clause
   * carrying no token (fixed wording) lists none and is always emitted.
   */
  readonly requires: readonly string[];
  /**
   * Text joining this clause to the one before it. Defaults to ", "; a clause
   * that continues the same sentence ("(company number 01003142)") uses " ".
   */
  readonly separator?: string;
};

const DEFAULT_SEPARATOR = ", ";

const joinClauses = (clauses: readonly RegistryFormatClause[]): string =>
  clauses
    .map(({ template, separator }, index) =>
      index === 0 ? template : `${separator ?? DEFAULT_SEPARATOR}${template}`,
    )
    .join("");

/** The author-facing default: every clause, particulars assumed present. */
export const formatFromClauses = (
  clauses: readonly RegistryFormatClause[],
): string => joinClauses(clauses);

/**
 * The clauses a hit can actually fill, given the tokens resolved for it.
 * `separator` is re-evaluated against the surviving neighbours, so dropping a
 * middle clause never leaves a doubled or dangling separator.
 */
export const clausesForTokens = (
  clauses: readonly RegistryFormatClause[],
  tokens: Readonly<Record<string, string | null | undefined>>,
): RegistryFormatClause[] =>
  clauses.filter(({ requires }) =>
    requires.every((token) => {
      const value = tokens[token];
      return value !== null && value !== undefined && value.trim() !== "";
    }),
  );

/** The template to render for a hit: the clauses it can fill, joined. */
export const templateForTokens = (
  clauses: readonly RegistryFormatClause[],
  tokens: Readonly<Record<string, string | null | undefined>>,
): string => joinClauses(clausesForTokens(clauses, tokens));
