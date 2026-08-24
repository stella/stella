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
  DeepLDocumentError,
  DeepLQuotaError,
  DeepLRateLimitError,
  DeepLTimeoutError,
  DeepLUpstreamError,
} from "@/api/lib/deepl/errors";
export type { DeepLError } from "@/api/lib/deepl/errors";
