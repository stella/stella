import * as v from "valibot";

/**
 * The stored metadata key holding a decision's language manifest: every
 * language expression its publisher lists for the decision's work, with the
 * formats each is published in. A row is one language version, so this is the
 * publisher's statement of which rows the work should have.
 */
export const CASE_LAW_WORK_EXPRESSIONS_METADATA_KEY = "workExpressions";

/** One language expression of a decision's work, as stored. */
export const caseLawWorkExpressionSchema = v.object({
  /** The language as the publisher's authority code states it (`CES`). */
  authorityCode: v.string(),
  /**
   * The language tag a row of this corpus carries for that expression
   * (`cs`), or null when the code names no language the corpus stores.
   */
  language: v.nullable(v.string()),
  /** Manifestation types the expression is published in, sorted. */
  formats: v.array(v.string()),
});

export type CaseLawWorkExpression = v.InferOutput<
  typeof caseLawWorkExpressionSchema
>;

const workExpressionsSchema = v.array(caseLawWorkExpressionSchema);

/**
 * The row language tags the publisher lists for a decision's work, sorted and
 * distinct: what the decision read serves as `sourceLanguages`. Null when the
 * row states no manifest, which is not the same as a manifest of one language.
 */
export const caseLawSourceLanguagesOf = (
  metadata: Readonly<Record<string, unknown>> | null,
): string[] | null => {
  const parsed = v.safeParse(
    workExpressionsSchema,
    metadata?.[CASE_LAW_WORK_EXPRESSIONS_METADATA_KEY],
  );
  if (!parsed.success) {
    return null;
  }
  return [
    ...new Set(
      parsed.output.flatMap(({ language }) =>
        language === null ? [] : [language],
      ),
    ),
  ].toSorted((left, right) => (left < right ? -1 : 1));
};
