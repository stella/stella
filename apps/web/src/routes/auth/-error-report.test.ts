import { expect, mock, test } from "bun:test";

import { reportOAuthCallbackError } from "@/routes/auth/-error-report";

test("account_not_linked reports without a generic toast", () => {
  const report = mock(
    (
      _error: unknown,
      _fallback: string,
      _options: { feature: string; routeTemplate: string },
    ) => true,
  );
  const reportWithoutToast = mock(
    (
      _error: unknown,
      _feature: string | undefined,
      _routeTemplate: string | undefined,
    ) => undefined,
  );

  reportOAuthCallbackError({
    errorCode: "account_not_linked",
    fallback: "Sign-in failed",
    report,
    reportWithoutToast,
  });

  expect(report).not.toHaveBeenCalled();
  expect(reportWithoutToast).toHaveBeenCalledTimes(1);
  const [error, feature, routeTemplate] =
    reportWithoutToast.mock.calls.at(0) ?? [];
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) {
    throw new TypeError("Expected an OAuth callback error");
  }
  expect(error.message).toBe("account_not_linked");
  expect(feature).toBe("auth");
  expect(routeTemplate).toBe("/auth/error");
});

test("another auth error reports with a toast", () => {
  const report = mock(
    (
      _error: unknown,
      _fallback: string,
      _options: { feature: string; routeTemplate: string },
    ) => true,
  );
  const reportWithoutToast = mock(
    (
      _error: unknown,
      _feature: string | undefined,
      _routeTemplate: string | undefined,
    ) => undefined,
  );

  reportOAuthCallbackError({
    errorCode: "access_denied",
    fallback: "Sign-in failed",
    report,
    reportWithoutToast,
  });

  expect(reportWithoutToast).not.toHaveBeenCalled();
  expect(report).toHaveBeenCalledTimes(1);
  const [error, fallback, options] = report.mock.calls.at(0) ?? [];
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) {
    throw new TypeError("Expected an OAuth callback error");
  }
  expect(error.message).toBe("access_denied");
  expect(fallback).toBe("Sign-in failed");
  expect(options).toEqual({
    feature: "auth",
    routeTemplate: "/auth/error",
  });
});
