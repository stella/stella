import { afterEach, expect, mock, spyOn, test } from "bun:test";

import { PROFESSIONAL_USE_REQUIRED_CODE } from "@stll/api-contract/professional-use";
import { stellaToast } from "@stll/ui/toast";

import { reportUnhandledAuthClientError } from "@/lib/account/auth-code-report";
import { sanitizeExceptionEvent } from "@/lib/analytics/posthog";
import { getAnalytics } from "@/lib/analytics/provider";
import { WEB_ANALYTICS_EVENTS } from "@/lib/analytics/types";
import { webApiClientOptions } from "@/lib/api";
import {
  reportUserVisibleError,
  resetUserErrorReportDedupeForTests,
  setUserErrorRouteTemplate,
} from "@/lib/errors/user-toast";
import { reportOAuthCallbackError } from "@/routes/auth/-error-report";

const PROFESSIONAL_USE_ERROR = {
  code: PROFESSIONAL_USE_REQUIRED_CODE,
  message: "Accept the professional-use statement to continue.",
  status: 403,
  statusText: "Forbidden",
};

afterEach(() => {
  resetUserErrorReportDedupeForTests();
  setUserErrorRouteTemplate("unknown");
  mock.restore();
});

test.each([
  {
    name: "OAuth error redirect",
    routeTemplate: "/auth/error",
    replay: async () => {
      reportOAuthCallbackError({
        errorCode: PROFESSIONAL_USE_REQUIRED_CODE,
        fallback: "Sign-in failed",
      });
    },
  },
  {
    name: "auth client session response",
    routeTemplate: "/auth/organization",
    replay: async () => {
      reportUnhandledAuthClientError(
        PROFESSIONAL_USE_ERROR,
        reportUserVisibleError,
        "https://api.test/api/auth/get-session",
      );
    },
  },
  {
    name: "Eden me response",
    routeTemplate: "/auth/organization",
    replay: async () => {
      const response = new Response(JSON.stringify(PROFESSIONAL_USE_ERROR), {
        headers: { "content-type": "application/json" },
        status: 403,
      });
      Object.defineProperty(response, "url", {
        value: "https://api.test/v1/me/professional-use",
      });
      await webApiClientOptions.onScopedResponse({
        response,
        scope: {
          type: "request",
          method: "GET",
          routeTemplate: "/v1/me/professional-use",
        },
      });
    },
  },
])("reports one user-visible auth error from the $name", async (path) => {
  const capture = spyOn(getAnalytics(), "captureError").mockImplementation(
    () => undefined,
  );
  spyOn(stellaToast, "add").mockReturnValue("auth-error");
  setUserErrorRouteTemplate(path.routeTemplate);

  await path.replay();

  expect(capture).toHaveBeenCalledTimes(1);
  const [, options] = capture.mock.calls.at(0) ?? [];
  const context = options?.context;
  expect(options).toEqual({
    fingerprintKey: "reportUserVisibleError:failure",
    scope: {
      type: "request",
      method: "GET",
      routeTemplate: path.routeTemplate,
    },
    context: {
      feature: "auth",
      routeTemplate: path.routeTemplate,
      type: "user-visible",
    },
  });
  if (context?.type !== "user-visible") {
    throw new TypeError("Expected user-visible error context");
  }

  const kept = sanitizeExceptionEvent(
    {
      event: WEB_ANALYTICS_EVENTS.exception,
      properties: {
        $exception_list: [{ type: "Error", value: "private detail" }],
        feature: context.feature,
        route_template: context.routeTemplate,
        user_visible: true,
      },
      uuid: "auth-error-event",
    },
    new Map(),
  );
  expect(kept.properties).toMatchObject({
    feature: "auth",
    route_template: path.routeTemplate,
    user_visible: true,
  });
});

test.each([
  {
    code: PROFESSIONAL_USE_REQUIRED_CODE,
    name: "caller-owned social-link hint errors",
    requestUrl: "https://api.test/api/auth/social-link-hint",
    reported: false,
  },
  {
    code: "INVALID_OTP",
    name: "caller-handled invalid OTP errors",
    requestUrl: "https://api.test/api/auth/email-otp/verify-email",
    reported: false,
  },
  {
    code: "OTP_EXPIRED",
    name: "caller-handled expired OTP errors",
    requestUrl: "https://api.test/api/auth/sign-in/email-otp",
    reported: false,
  },
  {
    code: PROFESSIONAL_USE_REQUIRED_CODE,
    name: "other unhandled auth errors",
    requestUrl: "https://api.test/api/auth/get-session",
    reported: true,
  },
])(
  "reports $name only when globally owned",
  ({ code, requestUrl, reported }) => {
    const report = mock(() => undefined);

    reportUnhandledAuthClientError(
      { ...PROFESSIONAL_USE_ERROR, code },
      report,
      requestUrl,
    );

    expect(report).toHaveBeenCalledTimes(reported ? 1 : 0);
  },
);

test.each([
  { code: "UNAUTHORIZED", reported: false, status: 401 },
  { code: "SESSION_EXPIRED", reported: false, status: 401 },
  { code: "UNAUTHORIZED", reported: true, status: 400 },
  { code: "INVALID_EMAIL_OR_PASSWORD", reported: true, status: 401 },
])(
  "reports $code on a $status only when it is not an ended session",
  ({ code, reported, status }) => {
    const report = mock(() => undefined);

    reportUnhandledAuthClientError(
      { code, message: "Unauthorized", status, statusText: "Unauthorized" },
      report,
      "https://api.test/api/auth/organization/get-active-member-role",
    );

    expect(report).toHaveBeenCalledTimes(reported ? 1 : 0);
  },
);

test.each([
  {
    name: "refused credentials on password sign-in",
    requestUrl: "https://api.test/api/auth/sign-in/email",
    reported: false,
  },
  {
    name: "refused credentials on another auth route",
    requestUrl: "https://api.test/api/auth/change-email",
    reported: true,
  },
])("reports $name only when no form owns them", ({ requestUrl, reported }) => {
  const report = mock(() => undefined);

  reportUnhandledAuthClientError(
    {
      code: "INVALID_EMAIL_OR_PASSWORD",
      message: "Invalid email or password",
      status: 401,
      statusText: "Unauthorized",
    },
    report,
    requestUrl,
  );

  expect(report).toHaveBeenCalledTimes(reported ? 1 : 0);
});

test("an ended session on a me route reports nothing", async () => {
  const capture = spyOn(getAnalytics(), "captureError").mockImplementation(
    () => undefined,
  );
  const response = new Response(
    JSON.stringify({
      code: "permission_denied",
      message: "Sign in to continue.",
    }),
    { headers: { "content-type": "application/json" }, status: 401 },
  );
  Object.defineProperty(response, "url", {
    value: "https://api.test/v1/me/professional-use",
  });

  await webApiClientOptions.onScopedResponse({
    response,
    scope: {
      type: "request",
      method: "GET",
      routeTemplate: "/v1/me/professional-use",
    },
  });

  expect(capture).not.toHaveBeenCalled();
});
