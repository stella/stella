export {
  fetchTargetLanguages,
  maskDeepLKey,
  resolveDeepLBaseUrl,
  translateTextBatches,
  translateTextBatch,
  translateDocument,
} from "@/api/lib/deepl/client";
export type {
  DeepLFormality,
  TranslateDocumentInput,
  TranslateDocumentResult,
  TranslateTextBatchInput,
} from "@/api/lib/deepl/client";
export {
  DeepLAuthError,
  DeepLQuotaError,
  DeepLRateLimitError,
} from "@/api/lib/deepl/errors";
