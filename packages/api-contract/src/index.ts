/** Version of the public REST request and response contract. */
export const STELLA_REST_API_CONTRACT_VERSION = 1 as const;

export { CHAT_TOOL_SCOPE } from "./chat";
export type { ChatSendRequest, SafeId } from "./chat";
export { API_VALIDATION_ERROR_CODE, normalizeApiError } from "./error";
export type {
  ApiErrorInput,
  ApiErrorObjectValue,
  ApiErrorValue,
  ApiValidationErrorValue,
  NormalizedApiError,
} from "./error";

/** Path prefix shared by the REST router and direct-fetch clients. */
export const STELLA_API_VERSION_PREFIX = "/v1" as const;

export const buildVersionedApiUrl = (
  origin: string,
  path: `/${string}`,
): string =>
  `${origin.endsWith("/") ? origin.slice(0, -1) : origin}${STELLA_API_VERSION_PREFIX}${path}`;
