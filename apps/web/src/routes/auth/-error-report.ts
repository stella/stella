import { TaggedError } from "better-result";

import type { OAuthCallbackErrorCode } from "@stll/api-contract/oauth-callback-error";
import { OAUTH_CALLBACK_ERROR_CODES } from "@stll/api-contract/oauth-callback-error";
import { declareFingerprintFields } from "@stll/errors/fingerprint-fields";

import {
  notifyUserError,
  reportUserVisibleError,
} from "@/lib/errors/user-toast";

const UNKNOWN_OAUTH_CALLBACK_ERROR = "unknown";

type OAuthCallbackErrorReason =
  OAuthCallbackErrorCode | typeof UNKNOWN_OAUTH_CALLBACK_ERROR;

const oauthCallbackErrorReason = (code: string): OAuthCallbackErrorReason =>
  OAUTH_CALLBACK_ERROR_CODES.find((known) => known === code) ??
  UNKNOWN_OAUTH_CALLBACK_ERROR;

class OAuthCallbackError extends TaggedError("OAuthCallbackError")<{
  message: string;
  reason: OAuthCallbackErrorReason;
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

type OAuthErrorReporter = (
  error: unknown,
  fallback: string,
  options: { feature: string; routeTemplate: string },
) => boolean;

type ReportOAuthCallbackErrorOptions = {
  errorCode: string | undefined;
  fallback: string;
  report?: OAuthErrorReporter | undefined;
  reportWithoutToast?: typeof reportUserVisibleError | undefined;
};

export const reportOAuthCallbackError = ({
  errorCode,
  fallback,
  report = notifyUserError,
  reportWithoutToast = reportUserVisibleError,
}: ReportOAuthCallbackErrorOptions): void => {
  if (errorCode === undefined) {
    return;
  }
  const reason = oauthCallbackErrorReason(errorCode);
  const error = new OAuthCallbackError({
    message: `OAuth callback failed: ${reason}`,
    reason,
  });
  if (reason === "account_not_linked") {
    reportWithoutToast(error, "auth", "/auth/error");
    return;
  }
  report(error, fallback, {
    feature: "auth",
    routeTemplate: "/auth/error",
  });
};
