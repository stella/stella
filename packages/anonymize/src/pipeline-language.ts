import languageScopes from "./data/language-scopes.json";

export type SupportedLanguage =
  | "cs"
  | "de"
  | "en"
  | "es"
  | "fr"
  | "hu"
  | "it"
  | "lv"
  | "pl"
  | "pt-br"
  | "ro"
  | "sk"
  | "sv";

const isSupportedLanguage = (language: string): language is SupportedLanguage =>
  Object.hasOwn(languageScopes.languages, language);

export const SUPPORTED_LANGUAGES = Object.freeze(
  Object.keys(languageScopes.languages).filter(isSupportedLanguage).toSorted(),
);

export type PipelineLanguageSelection =
  | SupportedLanguage
  | readonly [SupportedLanguage, ...SupportedLanguage[]]
  | "all";

export type NormalizedPipelineLanguageSelection =
  | { type: "all" }
  | {
      type: "languages";
      languages: readonly [SupportedLanguage, ...SupportedLanguage[]];
    };

const normalizeLanguage = (language: unknown): SupportedLanguage => {
  if (typeof language !== "string") {
    throw new TypeError("Pipeline language codes must be strings");
  }
  const normalized = language.trim().toLowerCase();
  if (!isSupportedLanguage(normalized)) {
    throw new RangeError(
      `Unsupported pipeline language ${JSON.stringify(language)}; expected one of: ${SUPPORTED_LANGUAGES.join(", ")}`,
    );
  }
  return normalized;
};

export const normalizePipelineLanguageSelection = (
  selection: PipelineLanguageSelection | undefined,
): NormalizedPipelineLanguageSelection => {
  if (
    selection === undefined ||
    (typeof selection === "string" && selection.trim().toLowerCase() === "all")
  ) {
    return { type: "all" };
  }
  const requested = Array.isArray(selection) ? selection : [selection];
  if (requested.length === 0) {
    throw new RangeError("Pipeline language selection must not be empty");
  }
  const normalized = [...new Set(requested.map(normalizeLanguage))].toSorted();
  const first = normalized.at(0);
  if (first === undefined) {
    throw new RangeError("Pipeline language selection must not be empty");
  }
  return { type: "languages", languages: [first, ...normalized.slice(1)] };
};

export const pipelineLanguageSelectionKey = (
  selection: NormalizedPipelineLanguageSelection,
): string => (selection.type === "all" ? "all" : selection.languages.join(","));
