// Metro does not remap explicit ESM `.js` specifiers to TypeScript sources.
// Keep the package's NodeNext entrypoint strict while exposing an entry whose
// extensionless imports follow Metro's native and web resolution rules.
export {
  isLanguageCode,
  LANGUAGES,
  UI_LANGUAGES,
  UI_LOCALES,
} from "./languages";
export type {
  Language,
  LanguageCode,
  LanguageEntry,
  UiLocale,
} from "./languages";
export {
  displayLanguageName,
  isUiLocale,
  resolveUiLocale,
  toLanguageCode,
} from "./helpers";
