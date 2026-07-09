import { TaggedError } from "better-result";

import { getTranslator } from "@/i18n/i18n-store";
import type { TranslationKey } from "@/i18n/types";

export { FetchBoundaryError } from "@stll/errors";

export class APIError extends TaggedError("ApiError")<{
  code?: string | undefined;
  status: number;
  message: string;
  rawMessage?: string | undefined;
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
        code?: string | undefined;
        type?: never;
        message: string;
      }
    | null
    | undefined;
};

export const toAPIError = ({ status, value }: ToAPIErrorProps) => {
  if (value === null || value === undefined) {
    return new APIError({
      message: localizeAPIError({ status }),
      status,
    });
  }

  if (typeof value === "string") {
    return new APIError({
      message: localizeAPIError({ status }),
      rawMessage: value,
      status,
    });
  }

  if (value.type === "validation") {
    const rawMessage = JSON.stringify(value);
    return new APIError({
      code: API_ERROR_CODE.validation,
      message: localizeAPIError({ code: API_ERROR_CODE.validation, status }),
      rawMessage,
      status,
    });
  }

  // Keep all non-validation fields under `details` so consumers
  // (e.g. the usage-limit modal hook) can read structured
  // payload without re-fetching. `message` is hoisted for the
  // simple toast path.
  const details = pickDetails(value);
  const rawMessage = value.message;
  return new APIError({
    ...(value.code ? { code: value.code } : {}),
    status,
    message: localizeAPIError({
      code: value.code,
      details,
      status,
    }),
    rawMessage,
    ...(details ? { details } : {}),
  });
};

const API_ERROR_CODE = {
  validation: "validation",
} as const;

const STATUS_ERROR_KEYS = {
  badRequest: "errors.api.badRequest",
  conflict: "errors.api.conflict",
  forbidden: "errors.api.forbidden",
  notFound: "errors.api.notFound",
  payloadTooLarge: "errors.api.payloadTooLarge",
  rateLimited: "errors.api.rateLimited",
  server: "errors.api.server",
  serviceUnavailable: "errors.api.serviceUnavailable",
  unauthorized: "errors.api.unauthorized",
  unknown: "errors.api.unknown",
  validation: "errors.api.validation",
} as const satisfies Record<string, TranslationKey>;

const CODE_ERROR_KEYS = {
  access_denied: "errors.apiCodes.accessDenied",
  forbidden: "errors.apiCodes.forbidden",
  internal_server_error: "errors.apiCodes.internalServerError",
  third_party_boundary_refusal: "errors.apiCodes.thirdPartyBoundaryRefusal",
  usage_limit_exceeded: "errors.apiCodes.usageLimitExceeded",
  validation: STATUS_ERROR_KEYS.validation,
} as const satisfies Record<string, TranslationKey>;

const STATUS_TO_KEY: Readonly<Record<number, TranslationKey | undefined>> = {
  400: STATUS_ERROR_KEYS.badRequest,
  401: STATUS_ERROR_KEYS.unauthorized,
  403: STATUS_ERROR_KEYS.forbidden,
  404: STATUS_ERROR_KEYS.notFound,
  409: STATUS_ERROR_KEYS.conflict,
  413: STATUS_ERROR_KEYS.payloadTooLarge,
  422: STATUS_ERROR_KEYS.validation,
  429: STATUS_ERROR_KEYS.rateLimited,
  500: STATUS_ERROR_KEYS.server,
  502: STATUS_ERROR_KEYS.serviceUnavailable,
};

const isKnownErrorCode = (code: string): code is keyof typeof CODE_ERROR_KEYS =>
  Object.hasOwn(CODE_ERROR_KEYS, code);

const isDisplayableAPIError = (error: APIError): boolean =>
  typeof error.code === "string" && isKnownErrorCode(error.code);

const translate = (key: TranslationKey): string => getTranslator()(key);

type LocalizeAPIErrorInput = {
  code?: string | undefined;
  details?: Record<string, unknown> | undefined;
  status: number;
};

const localizeAPIError = ({
  code,
  details,
  status,
}: LocalizeAPIErrorInput): string => {
  if (code && isKnownErrorCode(code)) {
    return translate(CODE_ERROR_KEYS[code]);
  }
  if (
    status === 402 &&
    typeof details?.["reason"] === "string" &&
    isKnownErrorCode(details["reason"])
  ) {
    return translate(CODE_ERROR_KEYS[details["reason"]]);
  }
  return translate(STATUS_TO_KEY[status] ?? STATUS_ERROR_KEYS.unknown);
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
  const apiError = toAPIError(error);
  return isDisplayableAPIError(apiError) ? apiError.message : fallback;
};

/** User-safe error description for thrown errors (e.g. from
 *  `useMutation` onError). Accepts any thrown value; falls back to
 *  the supplied text for non-API failures and 5xx responses. */
export const userErrorFromThrown = (
  error: unknown,
  fallback: string,
): string => {
  if (AuthClientError.is(error)) {
    return error.message;
  }
  if (APIError.is(error)) {
    if (error.status >= SERVER_ERROR_THRESHOLD) {
      return fallback;
    }
    return isDisplayableAPIError(error) ? error.message : fallback;
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
  Object.hasOwn(AUTH_ERROR_CODES, code);

const AUTH_ERROR_KEYS = {
  YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION:
    "errors.apiCodes.notOrganizationMember",
} as const satisfies Record<AuthErrorCode, TranslationKey>;

export const toAuthClientError = (props: ToAuthClientErrorProps) => {
  const { code, status, statusText } = props;
  const message = translate(STATUS_TO_KEY[status] ?? STATUS_ERROR_KEYS.unknown);

  if (!props.code) {
    return new AuthClientError({ message, status, statusText });
  }

  if (code && isAuthClientErrorCode(code)) {
    return new AuthClientError({
      code,
      message: translate(AUTH_ERROR_KEYS[code]),
      status,
      statusText,
    });
  }

  return new APIError({
    code,
    message,
    rawMessage: props.message,
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
