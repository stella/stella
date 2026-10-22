import { expect, mock, test } from "bun:test";

import { reportOAuthCallbackError } from "@/routes/auth/-error-report";

test("the auth error route reports its OAuth code as user-visible", () => {
  const report = mock(
    (
      _error: unknown,
      _fallback: string,
      _options: { feature: string; routeTemplate: string },
    ) => true,
  );

  reportOAuthCallbackError({
    errorCode: "account_not_linked",
    fallback: "Sign-in failed",
    report,
  });

  expect(report).toHaveBeenCalledTimes(1);
  const [error, fallback, options] = report.mock.calls.at(0) ?? [];
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) {
    throw new TypeError("Expected an OAuth callback error");
  }
  expect(error.message).toBe("account_not_linked");
  expect(fallback).toBe("Sign-in failed");
  expect(options).toEqual({
    feature: "auth",
    routeTemplate: "/auth/error",
  });
});
