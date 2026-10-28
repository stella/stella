import { describe, expect, test } from "bun:test";

import { isSignInRedirect } from "./redirect";

describe("sign-in redirect", () => {
  test("the callback is recognised in every form the system delivers", () => {
    expect(isSignInRedirect("app.stll:/oauth/callback?code=c&state=s")).toBe(
      true,
    );
    expect(isSignInRedirect("app.stll:///oauth/callback?error=denied")).toBe(
      true,
    );
    expect(isSignInRedirect("app.stll.dev:/oauth/callback?code=c")).toBe(true);
    expect(isSignInRedirect("/oauth/callback?code=c")).toBe(true);
  });

  test("every other link still reaches its screen", () => {
    expect(isSignInRedirect("app.stll:/matters")).toBe(false);
    expect(isSignInRedirect("/oauth/callback/extra")).toBe(false);
    expect(isSignInRedirect("/")).toBe(false);
  });
});
