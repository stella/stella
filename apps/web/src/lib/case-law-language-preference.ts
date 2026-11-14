import { pickCaseLawLanguageVersion } from "@stll/api-contract/case-law-reading-languages";

type CaseLawLanguageVariant = { language: string };

type PickPreferredCaseLawLanguageVariantOptions<
  TVariant extends CaseLawLanguageVariant,
> = {
  /** Every language version of the decision; empty for a monolingual one. */
  alternates: readonly TVariant[];
  /**
   * The version the server answered with: the one a search matched, or the
   * one a listing chose by the same reading order, the language of the case
   * included.
   */
  rowLanguage?: string | null | undefined;
  /** The reader's languages, most preferred first (`useCaseLawReadingLanguages`). */
  readingLanguages: readonly string[];
};

/**
 * Which language version of a multilingual decision to open first: the
 * reader's languages in order (UI language, practice jurisdictions, French),
 * then the version the row stands for, which the server chose knowing the
 * language of the case. Null only when there is nothing to choose from.
 */
export const pickPreferredCaseLawLanguageVariant = <
  TVariant extends CaseLawLanguageVariant,
>({
  alternates,
  rowLanguage,
  readingLanguages,
}: PickPreferredCaseLawLanguageVariantOptions<TVariant>): TVariant | null =>
  pickCaseLawLanguageVersion(alternates, {
    readingLanguages,
    caseLanguage: rowLanguage ?? null,
  });
