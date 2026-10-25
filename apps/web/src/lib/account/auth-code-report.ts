import { Result } from "better-result";

import type { ScopedResponse } from "@stll/api-client";

import { toAPIError } from "@/lib/errors/api";
import { toAuthClientError } from "@/lib/errors/auth";

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

// These codes have an explicit inline outcome in the web client. Every other
// server-declared auth code is unexpected and must not disappear into the
// SDK's console-only error handling.
const HANDLED_AUTH_CLIENT_CODES: ReadonlySet<string> = new Set([
  "DISPOSABLE_EMAIL_NOT_ALLOWED",
  "INVALID_BACKUP_CODE",
  "INVALID_CODE",
  "INVALID_OTP",
  "YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION",
]);

export const SOCIAL_LINK_HINT_PATH = "/social-link-hint";

const isSocialLinkHintRequest = (requestUrl: URL | string): boolean =>
  new URL(requestUrl).pathname === `/api/auth${SOCIAL_LINK_HINT_PATH}`;

export const reportUnhandledAuthClientError = (
  error: AuthErrorValue,
  report: UserVisibleReporter,
  requestUrl: URL | string,
): void => {
  if (
    error.code === undefined ||
    HANDLED_AUTH_CLIENT_CODES.has(error.code) ||
    isSocialLinkHintRequest(requestUrl)
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
    typeof value.code !== "string"
  ) {
    return;
  }
  report(toAPIError({ status: response.status, value }), "auth", undefined);
};
