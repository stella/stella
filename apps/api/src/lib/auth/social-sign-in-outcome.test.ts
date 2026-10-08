import { APIError } from "better-auth/api";
import { afterEach, describe, expect, test } from "bun:test";

import { classifySocialCallback } from "@/api/lib/auth/social-sign-in-outcome";
import {
  emitSocialSignInOutcome,
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";

const errorUrl = "https://app.example.test/api/auth/error";

const redirectTo = (location: string) =>
  new APIError("FOUND", undefined, new Headers({ location }));

describe("social sign-in outcome", () => {
  afterEach(() => {
    resetMetricLineSinkForTesting();
  });

  test.each([
    [`${errorUrl}?error=account_not_linked`, "account_not_linked"],
    [`${errorUrl}?error=identity_not_allowed`, "identity_not_allowed"],
    [`${errorUrl}?error=invalid_code`, "failed"],
    [errorUrl, "failed"],
    ["https://app.example.test/matters", "completed"],
    ["https://app.example.test/matters?error=account_not_linked", "completed"],
    ["https://other.example.test/api/auth/error?error=x", "completed"],
  ])("classifies a redirect to %s as %s", (location, outcome) => {
    expect(classifySocialCallback(redirectTo(location), errorUrl)).toBe(
      outcome,
    );
  });

  test("treats anything but a redirect as a failure", () => {
    expect(classifySocialCallback(undefined, errorUrl)).toBe("failed");
    expect(classifySocialCallback({ ok: true }, errorUrl)).toBe("failed");
    expect(classifySocialCallback(new APIError("BAD_REQUEST"), errorUrl)).toBe(
      "failed",
    );
  });

  test("emits one count dimensioned by outcome only", () => {
    const lines: string[] = [];
    setMetricLineSinkForTesting((line) => {
      lines.push(line);
    });
    emitSocialSignInOutcome("account_not_linked", "google");
    expect(lines).toHaveLength(1);
    const record: unknown = JSON.parse(lines[0] ?? "");
    expect(record).toMatchObject({
      _aws: {
        CloudWatchMetrics: [
          {
            Namespace: "Stella/Api",
            Dimensions: [["outcome"]],
            Metrics: [{ Name: "SocialSignInOutcome", Unit: "Count" }],
          },
        ],
      },
      outcome: "account_not_linked",
      provider: "google",
      SocialSignInOutcome: 1,
    });
  });
});
