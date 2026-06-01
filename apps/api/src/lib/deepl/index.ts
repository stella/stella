export {
  fetchTargetLanguages,
  maskDeepLKey,
  resolveDeepLBaseUrl,
  translateDocument,
} from "@/api/lib/deepl/client";
export type {
  DeepLFormality,
  TranslateDocumentInput,
  TranslateDocumentResult,
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
