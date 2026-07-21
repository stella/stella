/** Version of the public REST request and response contract. */
export const STELLA_REST_API_CONTRACT_VERSION = 1 as const;

/** Native deep-link scheme shared by app configuration and auth validation. */
export const STELLA_MOBILE_SCHEME = "stella" as const;
export const STELLA_MOBILE_ORIGIN = `${STELLA_MOBILE_SCHEME}://` as const;

/** Better Auth cookie namespaces accepted by the native secure-store client. */
export const STELLA_AUTH_COOKIE_PREFIXES = [
  "better-auth",
  "stella-dev",
] as const;
export const STELLA_DEV_AUTH_COOKIE_PREFIX = STELLA_AUTH_COOKIE_PREFIXES[1];

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
