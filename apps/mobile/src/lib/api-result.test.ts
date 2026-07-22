import { describe, expect, test } from "bun:test";

import { MobileAPIError, unwrapEden } from "./api-result";

describe("unwrapEden", () => {
  test("preserves the success payload", () => {
    const payload = { value: "ok" };

    expect(unwrapEden({ data: payload, error: null })).toBe(payload);
  });

  test("normalizes API failures without displaying raw server text", () => {
    expect(() =>
      unwrapEden({
        data: null,
        error: {
          status: 403,
          value: { code: "forbidden", message: "internal detail" },
        },
      }),
    ).toThrow(MobileAPIError);

    try {
      unwrapEden({
        data: null,
        error: { status: 500, value: "sensitive upstream detail" },
      });
    } catch (error) {
      expect(MobileAPIError.is(error)).toBe(true);
      if (MobileAPIError.is(error)) {
        expect(error.message).toBe("The request could not be completed.");
        expect(error.status).toBe(500);
      }
    }
  });
});
