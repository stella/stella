import { describe, expect, test } from "bun:test";

import { authErrorMessage, isTwoFactorRedirect } from "./auth-result";

describe("mobile auth results", () => {
  test("recognizes only an explicit two-factor redirect", () => {
    expect(isTwoFactorRedirect({ twoFactorRedirect: true })).toBe(true);
    expect(isTwoFactorRedirect({ twoFactorRedirect: false })).toBe(false);
    expect(isTwoFactorRedirect(null)).toBe(false);
  });

  test("uses structured error messages and a safe fallback", () => {
    expect(authErrorMessage({ message: "Try again" }, "Fallback")).toBe(
      "Try again",
    );
    expect(authErrorMessage({ message: "" }, "Fallback")).toBe("Fallback");
    expect(authErrorMessage("secret internal value", "Fallback")).toBe(
      "Fallback",
    );
  });
});
