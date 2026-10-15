import { isRecord } from "@/api/lib/type-guards";

const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const GRANT_TYPES = new Set([
  "authorization_code",
  "refresh_token",
  "client_credentials",
  "urn:ietf:params:oauth:grant-type:jwt-bearer",
]);

export type AuthRefusal = {
  "auth.path": string;
  "http.status_code": number;
  "auth.error_code": string;
  "oauth.grant_type"?: string;
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

/**
 * Describes an auth endpoint's 4xx answer for the log. The request log only
 * knows the catch-all route that mounts auth, so without this a failing token
 * refresh is indistinguishable from any other refused auth call. Every value
 * is bounded: the endpoint's route pattern, the status, a protocol error code
 * and, for the token endpoint, a known grant type. No token, client secret,
 * email or user id is read.
 */
export const describeAuthRefusal = ({
  path,
  returned,
  body,
}: {
  path: string;
  returned: unknown;
  body: unknown;
}): { type: "refused"; attributes: AuthRefusal } | { type: "answered" } => {
  // Better Auth answers a refused request with its APIError: an object
  // carrying a numeric `statusCode` and the protocol `body`.
  const statusCode = isRecord(returned) ? returned["statusCode"] : undefined;
  if (typeof statusCode !== "number" || statusCode < 400 || statusCode >= 500) {
    return { type: "answered" };
  }
  const grantType = isRecord(body) ? body["grant_type"] : undefined;
  const attributes: AuthRefusal = {
    "auth.path": path,
    "http.status_code": statusCode,
    "auth.error_code": errorCodeOf(
      isRecord(returned) ? returned["body"] : undefined,
    ),
    ...(typeof grantType === "string" && GRANT_TYPES.has(grantType)
      ? { "oauth.grant_type": grantType }
      : {}),
  };
  return { type: "refused", attributes };
};
