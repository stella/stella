import languageScopes from "./data/language-scopes.json";

import type { PipelineConfig } from "./types";

type LanguageScope = {
  nameCorpusLanguages?: readonly string[];
  denyListCountries?: readonly string[];
};

type LanguageScopeData = {
  languages: Record<string, LanguageScope>;
};

const scopeData = languageScopes as LanguageScopeData;

const normalizeLanguage = (language: string): string =>
  language.trim().toLowerCase();

const fallbackLanguage = (language: string): string | null => {
  const index = language.indexOf("-");
  return index === -1 ? null : language.slice(0, index);
};

const uniquePush = (target: string[], values: readonly string[]): void => {
  const seen = new Set(target);
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    target.push(value);
  }
};

const resolveLanguageScope = (language: string): LanguageScope | null => {
  const normalized = normalizeLanguage(language);
  if (normalized.length === 0) {
    return null;
  }
  const exact = scopeData.languages[normalized];
  if (exact !== undefined) {
    return exact;
  }
  const fallback = fallbackLanguage(normalized);
  return fallback === null ? null : (scopeData.languages[fallback] ?? null);
};

const configuredLanguages = (config: PipelineConfig): readonly string[] => {
  if (config.languages !== undefined) {
    return config.languages;
  }
  return config.language === undefined ? [] : [config.language];
};

export const configuredContentLanguages = (
  config: Pick<PipelineConfig, "language" | "languages">,
): readonly string[] | undefined => {
  if (config.languages !== undefined) {
    return config.languages;
  }
  return config.language === undefined ? undefined : [config.language];
};

export const applyPipelineLanguageScope = (
  config: PipelineConfig,
): PipelineConfig => {
  const languages = configuredLanguages(config);
  if (languages.length === 0) {
    return config;
  }

  const nameCorpusLanguages: string[] = [];
  const denyListCountries: string[] = [];
  let hasResolvedScope = false;
  for (const language of languages) {
    const scope = resolveLanguageScope(language);
    if (scope === null) {
      continue;
    }
    hasResolvedScope = true;
    uniquePush(nameCorpusLanguages, scope.nameCorpusLanguages ?? []);
    uniquePush(denyListCountries, scope.denyListCountries ?? []);
  }

  const next: Partial<PipelineConfig> = {};
  if (config.nameCorpusLanguages === undefined && hasResolvedScope) {
    next.nameCorpusLanguages = nameCorpusLanguages;
  }
  if (config.denyListCountries === undefined && hasResolvedScope) {
    next.denyListCountries = denyListCountries;
  }

  return Object.keys(next).length === 0 ? config : { ...config, ...next };
};
