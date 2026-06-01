/**
 * Static list of DeepL target languages.
 *
 * DeepL's `/v2/languages?type=target` endpoint is the source
 * of truth, but the supported set changes rarely — keeping a
 * static copy avoids a network round-trip every time the
 * picker opens. Sort by display name; the picker renders in
 * order.
 */

export const DEEPL_TARGET_LANGUAGES = [
  { code: "AR", englishName: "Arabic" },
  { code: "BG", englishName: "Bulgarian" },
  { code: "ZH", englishName: "Chinese (simplified, ZH)" },
  { code: "ZH-HANS", englishName: "Chinese (simplified)" },
  { code: "ZH-HANT", englishName: "Chinese (traditional)" },
  { code: "CS", englishName: "Czech" },
  { code: "DA", englishName: "Danish" },
  { code: "NL", englishName: "Dutch" },
  { code: "EN-US", englishName: "English (American)" },
  { code: "EN-GB", englishName: "English (British)" },
  { code: "ET", englishName: "Estonian" },
  { code: "FI", englishName: "Finnish" },
  { code: "FR", englishName: "French" },
  { code: "DE", englishName: "German" },
  { code: "EL", englishName: "Greek" },
  { code: "HU", englishName: "Hungarian" },
  { code: "ID", englishName: "Indonesian" },
  { code: "IT", englishName: "Italian" },
  { code: "JA", englishName: "Japanese" },
  { code: "KO", englishName: "Korean" },
  { code: "LV", englishName: "Latvian" },
  { code: "LT", englishName: "Lithuanian" },
  { code: "NB", englishName: "Norwegian (Bokmål)" },
  { code: "PL", englishName: "Polish" },
  { code: "PT-BR", englishName: "Portuguese (Brazilian)" },
  { code: "PT-PT", englishName: "Portuguese (European)" },
  { code: "RO", englishName: "Romanian" },
  { code: "RU", englishName: "Russian" },
  { code: "SK", englishName: "Slovak" },
  { code: "SL", englishName: "Slovenian" },
  { code: "ES", englishName: "Spanish" },
  { code: "ES-419", englishName: "Spanish (Latin American)" },
  { code: "SV", englishName: "Swedish" },
  { code: "TR", englishName: "Turkish" },
  { code: "UK", englishName: "Ukrainian" },
] as const satisfies readonly { code: string; englishName: string }[];

export type DeepLTargetLanguage = (typeof DEEPL_TARGET_LANGUAGES)[number];
export type DeepLTargetLanguageCode = DeepLTargetLanguage["code"];
