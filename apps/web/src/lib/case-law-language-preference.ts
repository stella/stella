import { normalizeCaseLawLanguageSegment } from "@/lib/case-law-route";

type CaseLawLanguageVariant = { language: string };

type PickPreferredCaseLawLanguageVariantOptions<
  TVariant extends CaseLawLanguageVariant,
> = {
  /** Every language version of the decision; empty for a monolingual one. */
  alternates: readonly TVariant[];
  /** The version the search matched, when the hit came from a search. */
  matchedLanguage?: string | null | undefined;
  /** The locale the UI runs in. */
  uiLocale: string;
};

const primarySubtag = (language: string): string =>
  language.split("-")[0] ?? language;

const variantWithLanguage = <TVariant extends CaseLawLanguageVariant>(
  alternates: readonly TVariant[],
  predicate: (language: string) => boolean,
): TVariant | undefined =>
  alternates.find((alternate) => {
    const language = normalizeCaseLawLanguageSegment(alternate.language);
    return language !== null && predicate(language);
  });

/**
 * Which language version of a multilingual decision to open first.
 *
 * The UI language wins when the decision exists in it, then the UI language
 * without its region (pt-BR reads the pt version), then the version that
 * matched the search (its snippet is what the reader saw), then English as the
 * lingua franca of the corpus, then whatever comes first. Null only when there
 * is nothing to choose from.
 */
export const pickPreferredCaseLawLanguageVariant = <
  TVariant extends CaseLawLanguageVariant,
>({
  alternates,
  matchedLanguage,
  uiLocale,
}: PickPreferredCaseLawLanguageVariantOptions<TVariant>): TVariant | null => {
  if (alternates.length === 0) {
    return null;
  }
  const ui = normalizeCaseLawLanguageSegment(uiLocale);
  const matched = normalizeCaseLawLanguageSegment(matchedLanguage);

  return (
    (ui === null
      ? undefined
      : variantWithLanguage(alternates, (language) => language === ui)) ??
    (ui === null
      ? undefined
      : variantWithLanguage(
          alternates,
          (language) => primarySubtag(language) === primarySubtag(ui),
        )) ??
    (matched === null
      ? undefined
      : variantWithLanguage(alternates, (language) => language === matched)) ??
    variantWithLanguage(
      alternates,
      (language) => primarySubtag(language) === "en",
    ) ??
    alternates.at(0) ??
    null
  );
};
