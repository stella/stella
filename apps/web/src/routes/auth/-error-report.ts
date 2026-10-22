import { notifyUserError } from "@/lib/errors/user-toast";

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
};

export const reportOAuthCallbackError = ({
  errorCode,
  fallback,
  report = notifyUserError,
}: ReportOAuthCallbackErrorOptions): void => {
  if (errorCode === undefined) {
    return;
  }
  report(new OAuthCallbackError(errorCode), fallback, {
    feature: "auth",
    routeTemplate: "/auth/error",
  });
};
