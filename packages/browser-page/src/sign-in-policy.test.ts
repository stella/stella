import { describe, expect, test } from "bun:test";

import { BROWSER_CONTROL_ERROR_CODE } from "@stll/api-contract/browser-control";

import { isIdentityProviderUrl, needsMember } from "./sign-in-policy";

describe("isIdentityProviderUrl", () => {
  test.each([
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
    "https://login.microsoftonline.com/common/oauth2/authorize",
    "https://LOGIN.LIVE.COM/login.srf",
    "https://example.okta.com/app/sso",
    "https://tenant.eu.auth0.com/u/login",
    "https://tenant.b2clogin.com/tenant.onmicrosoft.com/oauth2",
  ])("treats %s as a sign-in page", (url) => {
    expect(isIdentityProviderUrl(url)).toBe(true);
  });

  test.each([
    "https://okta.com/",
    "https://notokta.com/login",
    "https://google.com/search?q=accounts.google.com",
    "https://fixture-library.test/search",
    "https://accounts.google.com.fixture-library.test/",
    "not a url",
  ])("leaves %s to the page's own fields", (url) => {
    expect(isIdentityProviderUrl(url)).toBe(false);
  });
});

test("a sign-in refusal names the member, never a snapshot", () => {
  const result = needsMember();
  expect(result.status).toBe("error");
  expect(result.status === "error" ? result.code : null).toBe(
    BROWSER_CONTROL_ERROR_CODE.needsMember,
  );
  expect(result).not.toHaveProperty("snapshot");
});
