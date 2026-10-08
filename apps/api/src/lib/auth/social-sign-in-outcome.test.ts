import { APIError } from "better-auth/api";
import { describe, expect, test } from "bun:test";

import {
  classifySocialCallback,
  socialCallbackErrorUrl,
  type SocialSignInOutcome,
} from "@/api/lib/auth/social-sign-in-outcome";

const errorUrl = "https://app.example.test/api/auth/error";
const authBaseUrl = "https://app.example.test/api/auth";

const redirectTo = (location: string) =>
  new APIError("FOUND", undefined, new Headers({ location }));

describe("social sign-in outcome", () => {
  test.each<[string, SocialSignInOutcome]>([
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

  test("classifies against the sign-in's own error destination", () => {
    const customErrorUrl = "https://app.example.test/sign-in/failed";
    const effective = socialCallbackErrorUrl(
      { callbackURL: "https://app.example.test/", errorURL: customErrorUrl },
      errorUrl,
      authBaseUrl,
    );
    expect(effective).toBe(customErrorUrl);
    expect(
      classifySocialCallback(
        redirectTo(`${customErrorUrl}?error=account_not_linked`),
        effective,
      ),
    ).toBe("account_not_linked");
    expect(
      classifySocialCallback(
        redirectTo(`${customErrorUrl}?error=identity_not_allowed`),
        effective,
      ),
    ).toBe("identity_not_allowed");
    // A completed sign-in still lands on its callback URL.
    expect(
      classifySocialCallback(
        redirectTo("https://app.example.test/"),
        effective,
      ),
    ).toBe("completed");
  });

  test("resolves a relative per-sign-in error destination", () => {
    const effective = socialCallbackErrorUrl(
      { errorURL: "/sign-in/failed" },
      errorUrl,
      authBaseUrl,
    );
    expect(effective).toBe("https://app.example.test/sign-in/failed");
    expect(
      classifySocialCallback(
        redirectTo("/sign-in/failed?error=account_not_linked"),
        effective,
      ),
    ).toBe("account_not_linked");
  });

  test("falls back to the global error URL without a per-sign-in one", () => {
    for (const state of [null, undefined, {}, { errorURL: "" }, "x"]) {
      expect(socialCallbackErrorUrl(state, errorUrl, authBaseUrl)).toBe(
        errorUrl,
      );
    }
  });

  test("treats anything but a redirect as a failure", () => {
    expect(classifySocialCallback(undefined, errorUrl)).toBe("failed");
    expect(classifySocialCallback({ ok: true }, errorUrl)).toBe("failed");
    expect(classifySocialCallback(new APIError("BAD_REQUEST"), errorUrl)).toBe(
      "failed",
    );
  });
});
