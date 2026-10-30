import {
  describeOAuthTokenRefusal,
  type OAuthTokenRefusalReason,
} from "@/api/lib/auth/oauth-token-refusal";
import { isRecord } from "@/api/lib/type-guards";

const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const GRANT_TYPES = new Set([
  "authorization_code",
  "refresh_token",
  "client_credentials",
  "urn:ietf:params:oauth:grant-type:jwt-bearer",
]);

const REFUSAL_DELIVERIES = {
  response: "response",
  redirect: "redirect",
} as const;

type RefusalDelivery =
  (typeof REFUSAL_DELIVERIES)[keyof typeof REFUSAL_DELIVERIES];

export type AuthRefusal = {
  "auth.path": string;
  "http.status_code": number;
  "auth.error_code": string;
  "auth.refusal_delivery": RefusalDelivery;
  "oauth.grant_type"?: string;
  "oauth.refusal_reason"?: OAuthTokenRefusalReason;
  "oauth.client_id"?: string;
  "oauth.grant_family"?: string;
  "oauth.refusal_unclassified"?: boolean;
  "request.id"?: string;
};

const errorCodeOf = (body: unknown): string => {
  if (!isRecord(body)) {
    return "unknown";
  }
  const code = body["error"] ?? body["code"];
  if (typeof code !== "string") {
    return "unknown";
  }
  const normalized = code.toLowerCase();
  return ERROR_CODE_PATTERN.test(normalized) ? normalized : "other";
};

// Resolves relative redirect targets; only the query and fragment are read.
const REDIRECT_TARGET_BASE = "https://redirect.invalid";

/** The `error` parameter of an OAuth error redirect, from the query or, in
 * fragment response mode, the fragment. */
const redirectErrorOf = (target: unknown): string | undefined => {
  if (typeof target !== "string") {
    return undefined;
  }
  const url = URL.parse(target, REDIRECT_TARGET_BASE);
  if (url === null) {
    return undefined;
  }
  return (
    url.searchParams.get("error") ??
    new URLSearchParams(url.hash.slice(1)).get("error") ??
    undefined
  );
};

type Refusal = {
  statusCode: number;
  errorCode: string;
  delivery: RefusalDelivery;
};

const redirectRefusal = (
  statusCode: number,
  target: unknown,
): Refusal | undefined => {
  const error = redirectErrorOf(target);
  return error === undefined
    ? undefined
    : {
        statusCode,
        errorCode: errorCodeOf({ error }),
        delivery: REFUSAL_DELIVERIES.redirect,
      };
};

// Better Auth answers a refused request with its APIError: an object carrying
// a numeric `statusCode` and the protocol `body`. The OAuth authorize flow
// instead refuses by redirecting with an `error` parameter: a thrown 3xx
// APIError with a `location` header or, for fetch callers, a 200
// `{ redirect: true, url }` answer.
const refusalOf = (returned: unknown): Refusal | undefined => {
  if (!isRecord(returned)) {
    return undefined;
  }
  if (returned["redirect"] === true) {
    return redirectRefusal(200, returned["url"]);
  }
  const statusCode = returned["statusCode"];
  if (typeof statusCode !== "number") {
    return undefined;
  }
  if (statusCode >= 400 && statusCode < 500) {
    return {
      statusCode,
      errorCode: errorCodeOf(returned["body"]),
      delivery: REFUSAL_DELIVERIES.response,
    };
  }
  const headers = returned["headers"];
  if (statusCode < 300 || statusCode >= 400 || !(headers instanceof Headers)) {
    return undefined;
  }
  return redirectRefusal(statusCode, headers.get("location"));
};

/**
 * Describes an auth endpoint's refusal for the log. The request log only
 * knows the catch-all route that mounts auth, so without this a failing token
 * refresh is indistinguishable from any other refused auth call. A refusal is
 * a 4xx answer or a redirect carrying an OAuth `error` parameter. Every value
 * is bounded: the endpoint's route pattern, the status, a protocol error code,
 * how the refusal was delivered and, for the token endpoint, a known grant
 * type; the redirect target itself is never logged. Token-grant observations
 * add the public client id, a typed reason and a hashed family identifier.
 * No token, client secret, email or user id enters the attributes.
 */
export const describeAuthRefusal = ({
  path,
  returned,
  body,
  oauthObservation,
  requestId,
}: {
  path: string;
  returned: unknown;
  body: unknown;
  oauthObservation?: unknown;
  requestId?: string;
}): { type: "refused"; attributes: AuthRefusal } | { type: "answered" } => {
  const refusal = refusalOf(returned);
  if (refusal === undefined) {
    return { type: "answered" };
  }
  const { statusCode, errorCode, delivery } = refusal;
  const grantType = isRecord(body) ? body["grant_type"] : undefined;
  const attributes: AuthRefusal = {
    "auth.path": path,
    "http.status_code": statusCode,
    "auth.error_code": errorCode,
    "auth.refusal_delivery": delivery,
    ...(typeof grantType === "string" && GRANT_TYPES.has(grantType)
      ? { "oauth.grant_type": grantType }
      : {}),
    ...(path === "/oauth2/token" &&
    (grantType === "refresh_token" || grantType === "authorization_code")
      ? describeOAuthTokenRefusal({
          observation: oauthObservation,
          body,
          errorCode,
        })
      : {}),
    ...(requestId === undefined ? {} : { "request.id": requestId }),
  };
  return { type: "refused", attributes };
};
