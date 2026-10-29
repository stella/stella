import {
  notifyUserError,
  reportUserVisibleError,
} from "@/lib/errors/user-toast";

class OAuthCallbackError extends Error {
  override name = "OAuthCallbackError";
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
  const error = new OAuthCallbackError(errorCode);
  if (errorCode === "account_not_linked") {
    reportWithoutToast(error, "auth", "/auth/error");
    return;
  }
  report(error, fallback, {
    feature: "auth",
    routeTemplate: "/auth/error",
  });
};
