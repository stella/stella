import { TaggedError } from "better-result";

export { FetchBoundaryError } from "@stll/errors";

export class APIError extends TaggedError("ApiError")<{
  status: number;
  message: string;
  /**
   * Structured fields some 4xx responses include alongside the
   * human-readable message. The 402 usage-limit path uses
   * `reason` + `required` + `available` so the frontend can render
   * a cap-warning UI without parsing the message text. Optional
   * everywhere; callers should guard before reading.
   */
  details?: Record<string, unknown> | undefined;
}>() {}

export class ClientOperationError extends TaggedError("ClientOperationError")<{
  action: string;
  message: string;
  cause?: unknown;
}>() {}

export class ClientCapabilityError extends TaggedError(
  "ClientCapabilityError",
)<{
  capability: string;
  message: string;
  cause?: unknown;
}>() {}

export { ClientTelemetryError } from "@/lib/errors/telemetry";

export class ClientUnknownError extends TaggedError("ClientUnknownError")<{
  message: string;
}>() {}

type ToAPIErrorProps = {
  status: number;
  value:
    | string
    | {
        type: "validation";
        on: string;
        summary?: string;
        message?: string;
        found?: unknown;
        property?: string;
        expected?: string;
      }
    | {
        type?: never;
        message: string;
      };
};

export const toAPIError = ({ status, value }: ToAPIErrorProps) => {
  if (typeof value === "string") {
    return new APIError({
      status,
      message: value,
    });
  }

  if (value.type === "validation") {
    return new APIError({
      status,
      message: JSON.stringify(value),
    });
  }

  // Keep all non-validation fields under `details` so consumers
  // (e.g. the usage-limit modal hook) can read structured
  // payload without re-fetching. `message` is hoisted for the
  // simple toast path.
  const details = pickDetails(value);
  return new APIError({
    status,
    message: value.message,
    ...(details ? { details } : {}),
  });
};

const KNOWN_TEXT_KEYS: ReadonlySet<string> = new Set(["message", "code"]);

const pickDetails = (
  value: { message: string } & Record<string, unknown>,
): Record<string, unknown> | undefined => {
  const entries = Object.entries(value).filter(
    ([key]) => !KNOWN_TEXT_KEYS.has(key),
  );
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
};

const SERVER_ERROR_THRESHOLD = 500;

/** User-safe error description for toasts.
 *  Hides raw 5xx details; shows the `fallback` instead. */
export const userErrorMessage = (
  error: ToAPIErrorProps,
  fallback: string,
): string => {
  if (error.status >= SERVER_ERROR_THRESHOLD) {
    return fallback;
  }
  return toAPIError(error).message;
};

/** User-safe error description for thrown errors (e.g. from
 *  `useMutation` onError). Accepts any thrown value; falls back to
 *  the supplied text for non-API failures and 5xx responses. */
export const userErrorFromThrown = (
  error: unknown,
  fallback: string,
): string => {
  if (APIError.is(error)) {
    if (error.status >= SERVER_ERROR_THRESHOLD) {
      return fallback;
    }
    return error.message;
  }
  return fallback;
};

const AUTH_ERROR_CODES = {
  YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION: true,
} as const;

type AuthErrorCode = keyof typeof AUTH_ERROR_CODES;

export class AuthClientError extends TaggedError("AuthClientError")<{
  code?: AuthErrorCode | undefined;
  message: string;
  status: number;
  statusText: string;
}>() {}

type ToAuthClientErrorProps = {
  code?: string | undefined;
  message?: string | undefined;
  status: number;
  statusText: string;
};

const isAuthClientErrorCode = (code: string): code is AuthErrorCode =>
  code in AUTH_ERROR_CODES;

export const toAuthClientError = (props: ToAuthClientErrorProps) => {
  const { code, status, statusText } = props;
  const message = props.message ?? "Unknown better-auth error";

  if (!props.code) {
    return new AuthClientError({ message, status, statusText });
  }

  if (code && isAuthClientErrorCode(code)) {
    return new AuthClientError({ code, message, status, statusText });
  }

  return new APIError({
    message: `${code} - ${message}`,
    status,
  });
};

export const isMemberError = (error: Error) => {
  if (
    AuthClientError.is(error) &&
    error.code === "YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION"
  ) {
    return true;
  }

  return false;
};

export const isUnauthorizedError = (error: Error) => {
  if (
    (APIError.is(error) || AuthClientError.is(error)) &&
    error.status === 401
  ) {
    return true;
  }

  return false;
};
