/**
 * Compatibility names for the shared API contract. Keeping the catalog in
 * `@stll/api-contract` makes the detector, request schema, and picker consume
 * one language definition.
 */
export {
  DOCUMENT_TRANSLATION_TARGET_LANGUAGES as DEEPL_TARGET_LANGUAGES,
  type DocumentTranslationTargetLanguage as DeepLTargetLanguage,
  type DocumentTranslationTargetLanguageCode as DeepLTargetLanguageCode,
} from "@stll/api-contract/document-translation";
