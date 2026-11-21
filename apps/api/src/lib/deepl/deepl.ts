export {
  fetchTargetLanguages,
  maskDeepLKey,
  resolveDeepLBaseUrl,
  translateTextBatches,
  translateDocument,
} from "@/api/lib/deepl/client";
export {
  DeepLAuthError,
  DeepLQuotaError,
  DeepLRateLimitError,
} from "@/api/lib/deepl/errors";
