export const DOCUMENT_TRANSLATION_SOURCE_LANGUAGES = [
  { code: "AR", detectorCode: "arb" },
  { code: "BG", detectorCode: "bul" },
  { code: "ZH", detectorCode: "cmn" },
  { code: "CS", detectorCode: "ces" },
  { code: "DA", detectorCode: "dan" },
  { code: "NL", detectorCode: "nld" },
  { code: "EN-GB", detectorCode: "eng" },
  { code: "ET", detectorCode: "est" },
  { code: "FI", detectorCode: "fin" },
  { code: "FR", detectorCode: "fra" },
  { code: "DE", detectorCode: "deu" },
  { code: "EL", detectorCode: "ell" },
  { code: "HU", detectorCode: "hun" },
  { code: "ID", detectorCode: "ind" },
  { code: "IT", detectorCode: "ita" },
  { code: "JA", detectorCode: "jpn" },
  { code: "KO", detectorCode: "kor" },
  { code: "LV", detectorCode: "lav" },
  { code: "LT", detectorCode: "lit" },
  { code: "NB", detectorCode: "nob" },
  { code: "PL", detectorCode: "pol" },
  { code: "PT-PT", detectorCode: "por" },
  { code: "RO", detectorCode: "ron" },
  { code: "RU", detectorCode: "rus" },
  { code: "SK", detectorCode: "slk" },
  { code: "SL", detectorCode: "slv" },
  { code: "ES", detectorCode: "spa" },
  { code: "SV", detectorCode: "swe" },
  { code: "TR", detectorCode: "tur" },
  { code: "UK", detectorCode: "ukr" },
] as const satisfies readonly { code: string; detectorCode: string }[];

export type DocumentTranslationSourceLanguage =
  (typeof DOCUMENT_TRANSLATION_SOURCE_LANGUAGES)[number];
export type DocumentTranslationSourceLanguageCode =
  DocumentTranslationSourceLanguage["code"];

/** Narrow a stored or detected code back onto the catalog. */
export const isDocumentTranslationSourceLanguageCode = (
  value: string,
): value is DocumentTranslationSourceLanguageCode =>
  DOCUMENT_TRANSLATION_SOURCE_LANGUAGES.some(
    (language) => language.code === value,
  );

export const DOCUMENT_TRANSLATION_TARGET_LANGUAGES = [
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

export type DocumentTranslationTargetLanguage =
  (typeof DOCUMENT_TRANSLATION_TARGET_LANGUAGES)[number];
export type DocumentTranslationTargetLanguageCode =
  DocumentTranslationTargetLanguage["code"];

const DOCUMENT_TRANSLATION_SOURCE_BY_TARGET = {
  AR: "AR",
  BG: "BG",
  ZH: "ZH",
  "ZH-HANS": "ZH",
  "ZH-HANT": "ZH",
  CS: "CS",
  DA: "DA",
  NL: "NL",
  "EN-US": "EN-GB",
  "EN-GB": "EN-GB",
  ET: "ET",
  FI: "FI",
  FR: "FR",
  DE: "DE",
  EL: "EL",
  HU: "HU",
  ID: "ID",
  IT: "IT",
  JA: "JA",
  KO: "KO",
  LV: "LV",
  LT: "LT",
  NB: "NB",
  PL: "PL",
  "PT-BR": "PT-PT",
  "PT-PT": "PT-PT",
  RO: "RO",
  RU: "RU",
  SK: "SK",
  SL: "SL",
  ES: "ES",
  "ES-419": "ES",
  SV: "SV",
  TR: "TR",
  UK: "UK",
} as const satisfies Record<
  DocumentTranslationTargetLanguageCode,
  DocumentTranslationSourceLanguageCode
>;

export const documentTranslationSourceForTarget = (
  target: DocumentTranslationTargetLanguageCode,
): DocumentTranslationSourceLanguageCode =>
  DOCUMENT_TRANSLATION_SOURCE_BY_TARGET[target];

export type DocumentTranslationSourceLanguageDetection =
  | {
      type: "detected";
      language: DocumentTranslationSourceLanguageCode;
      confidence: "high" | "medium";
    }
  | {
      type: "ambiguous";
      candidates: readonly DocumentTranslationSourceLanguageCode[];
    }
  | { type: "unknown" };

export const DOCUMENT_TRANSLATION_RUN_ERROR_CODES = [
  "document_unresolved",
  "document_changed",
  "unsupported_format",
  "unsupported_review_markup",
  "provider_unavailable",
  "translation_failed",
  "format_validation_failed",
  "internal",
] as const;
export type DocumentTranslationRunErrorCode =
  (typeof DOCUMENT_TRANSLATION_RUN_ERROR_CODES)[number];

export const DOCUMENT_TRANSLATION_DEEPL_MIME_TYPES = [
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/pdf",
  "text/plain",
  "text/html",
  "application/xliff+xml",
] as const satisfies readonly string[];

const DOCUMENT_TRANSLATION_DEEPL_MIME_TYPE_SET = new Set<string>(
  DOCUMENT_TRANSLATION_DEEPL_MIME_TYPES,
);

export const isDocumentTranslationDeepLSupportedMimeType = (
  mimeType: string,
): boolean => DOCUMENT_TRANSLATION_DEEPL_MIME_TYPE_SET.has(mimeType);

type DocumentTranslationSourceEligibility = {
  encrypted: boolean;
  mimeType: string;
};

export const isDocumentTranslationSourceEligible = ({
  encrypted,
  mimeType,
}: DocumentTranslationSourceEligibility): boolean =>
  !encrypted && isDocumentTranslationDeepLSupportedMimeType(mimeType);
