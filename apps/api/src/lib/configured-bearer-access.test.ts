import { describe, expect, test } from "bun:test";

import { authorizeConfiguredBearer } from "./configured-bearer-access";

const TOKEN = "service-test-token-0123456789abcdef";

describe("configured bearer access", () => {
  test("is disabled when no deployment token is configured", () => {
    expect(
      authorizeConfiguredBearer({
        authorizationHeader: `Bearer ${TOKEN}`,
        configuredToken: undefined,
      }),
    ).toEqual({ status: "disabled" });
  });

  test.each([null, TOKEN, `Basic ${TOKEN}`, `Bearer ${TOKEN}x`, "Bearer "])(
    "rejects non-matching header %s",
    (authorizationHeader) => {
      expect(
        authorizeConfiguredBearer({
          authorizationHeader,
          configuredToken: TOKEN,
        }),
      ).toEqual({ status: "unauthorized" });
    },
  );

  test("accepts only the exact bearer credential", () => {
    expect(
      authorizeConfiguredBearer({
        authorizationHeader: `Bearer ${TOKEN}`,
        configuredToken: TOKEN,
      }),
    ).toEqual({ status: "authorized" });
  });
});
