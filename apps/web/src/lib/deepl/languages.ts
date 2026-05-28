/**
 * Static list of DeepL target languages.
 *
 * DeepL's `/v2/languages?type=target` endpoint is the source
 * of truth, but the supported set changes rarely — keeping a
 * static copy avoids a network round-trip every time the
 * picker opens. Sort by display name; the picker renders in
 * order.
 */

export type DeepLTargetLanguage = {
  /** DeepL API language code, sent as the `target_lang` parameter. */
  code: string;
  /** English display name, also used as the i18n fallback. */
  englishName: string;
};

export const DEEPL_TARGET_LANGUAGES: readonly DeepLTargetLanguage[] = [
  { code: "AR", englishName: "Arabic" },
  { code: "BG", englishName: "Bulgarian" },
  { code: "CS", englishName: "Czech" },
  { code: "DA", englishName: "Danish" },
  { code: "DE", englishName: "German" },
  { code: "EL", englishName: "Greek" },
  { code: "EN-GB", englishName: "English (British)" },
  { code: "EN-US", englishName: "English (American)" },
  { code: "ES", englishName: "Spanish" },
  { code: "ET", englishName: "Estonian" },
  { code: "FI", englishName: "Finnish" },
  { code: "FR", englishName: "French" },
  { code: "HU", englishName: "Hungarian" },
  { code: "ID", englishName: "Indonesian" },
  { code: "IT", englishName: "Italian" },
  { code: "JA", englishName: "Japanese" },
  { code: "KO", englishName: "Korean" },
  { code: "LT", englishName: "Lithuanian" },
  { code: "LV", englishName: "Latvian" },
  { code: "NB", englishName: "Norwegian Bokmål" },
  { code: "NL", englishName: "Dutch" },
  { code: "PL", englishName: "Polish" },
  { code: "PT-BR", englishName: "Portuguese (Brazilian)" },
  { code: "PT-PT", englishName: "Portuguese (European)" },
  { code: "RO", englishName: "Romanian" },
  { code: "RU", englishName: "Russian" },
  { code: "SK", englishName: "Slovak" },
  { code: "SL", englishName: "Slovenian" },
  { code: "SV", englishName: "Swedish" },
  { code: "TR", englishName: "Turkish" },
  { code: "UK", englishName: "Ukrainian" },
  { code: "ZH", englishName: "Chinese (simplified)" },
];
