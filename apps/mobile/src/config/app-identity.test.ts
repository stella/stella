import { describe, expect, test } from "bun:test";

import { STELLA_MOBILE_SCHEME } from "@stll/api-contract";

import appConfig from "../../app.json" with { type: "json" };

describe("mobile app identity", () => {
  test("keeps the generated native scheme aligned with the auth contract", () => {
    expect(appConfig.expo.scheme).toBe(STELLA_MOBILE_SCHEME);
  });
});
