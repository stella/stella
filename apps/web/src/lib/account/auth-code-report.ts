import { Result } from "better-result";

import type { ScopedResponse } from "@stll/api-client";

import {
  isSessionRefusal,
  isTypedCodeRefusal,
  toAPIError,
} from "@/lib/errors/api";
import { isAuthClientErrorCode, toAuthClientError } from "@/lib/errors/auth";

type AuthErrorValue = {
  code?: string | undefined;
  message?: string | undefined;
  status: number;
  statusText: string;
};

type UserVisibleReporter = (
  error: unknown,
  feature: string | undefined,
  routeTemplate: string | undefined,
) => void;

export const SOCIAL_LINK_HINT_PATH = "/social-link-hint";

const isSocialLinkHintRequest = (requestUrl: URL | string): boolean =>
  new URL(requestUrl).pathname === `/api/auth${SOCIAL_LINK_HINT_PATH}`;

const PASSWORD_SIGN_IN_PATH = "/api/auth/sign-in/email";

// The password sign-in form shows its own message for refused credentials.
const isPasswordSignInRefusal = (
  error: AuthErrorValue,
  requestUrl: URL | string,
): boolean =>
  error.code === "INVALID_EMAIL_OR_PASSWORD" &&
  new URL(requestUrl).pathname === PASSWORD_SIGN_IN_PATH;

// A refused code, a session that has ended and a code with a message of its own
// each have an outcome in the web client. Any other server-declared auth code is
// unexpected and must not disappear into the SDK's console-only error handling.
export const reportUnhandledAuthClientError = (
  error: AuthErrorValue,
  report: UserVisibleReporter,
  requestUrl: URL | string,
): void => {
  if (
    error.code === undefined ||
    isAuthClientErrorCode(error.code) ||
    isTypedCodeRefusal(error) ||
    isSessionRefusal(error) ||
    isSocialLinkHintRequest(requestUrl) ||
    isPasswordSignInRefusal(error, requestUrl)
  ) {
    return;
  }
  report(toAuthClientError(error), "auth", undefined);
};

const ME_API_PATH = /^\/v1\/me(?:\/|$)/u;

export const reportUnhandledMeResponse = async (
  response: ScopedResponse,
  report: UserVisibleReporter,
): Promise<void> => {
  if (
    response.ok ||
    !URL.canParse(response.url) ||
    !ME_API_PATH.test(new URL(response.url).pathname)
  ) {
    return;
  }
  const text = await Result.tryPromise(
    async () => await response.clone().text(),
  );
  if (Result.isError(text)) {
    return;
  }
  const parsed = Result.try((): unknown => JSON.parse(text.value));
  if (Result.isError(parsed)) {
    return;
  }
  const value = parsed.value;
  if (
    typeof value !== "object" ||
    value === null ||
    !("code" in value) ||
    typeof value.code !== "string" ||
    isSessionRefusal({ code: value.code, status: response.status })
  ) {
    return;
  }
  report(toAPIError({ status: response.status, value }), "auth", undefined);
};
