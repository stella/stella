import { describe, expect, test } from "bun:test";

import { accountPageUrl } from "./account-page";

describe("the account page", () => {
  test("is the web app's profile settings on the issuer's origin", () => {
    expect(accountPageUrl("https://my.stll.app/api/auth")).toBe(
      "https://my.stll.app/settings/account/profile",
    );
    expect(accountPageUrl("http://localhost:3000/api/auth/")).toBe(
      "http://localhost:3000/settings/account/profile",
    );
  });
});
