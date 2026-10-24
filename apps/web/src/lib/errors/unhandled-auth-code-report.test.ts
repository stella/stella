import { afterEach, expect, mock, spyOn, test } from "bun:test";

import { PROFESSIONAL_USE_REQUIRED_CODE } from "@stll/api-contract/professional-use";
import { stellaToast } from "@stll/ui/toast";

import { reportUnhandledAuthClientError } from "@/lib/account/auth-code-report";
import { sanitizeExceptionEvent } from "@/lib/analytics/posthog";
import { getAnalytics } from "@/lib/analytics/provider";
import { WEB_ANALYTICS_EVENTS } from "@/lib/analytics/types";
import { webApiClientOptions } from "@/lib/eden-client";
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
      await webApiClientOptions.onResponse(response);
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
  const [, context] = capture.mock.calls.at(0) ?? [];
  expect(context).toEqual({
    feature: "auth",
    routeTemplate: path.routeTemplate,
    type: "user-visible",
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
