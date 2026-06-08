import { describe, expect, test } from "bun:test";

import { APIError } from "@/lib/errors";
import { CriticalQueryTimeoutError } from "@/lib/react-query";

import { isNetworkError } from "./route-components.logic";

describe("route network error classification", () => {
  test("recognises query timeouts and browser network errors", () => {
    expect(
      isNetworkError(
        new CriticalQueryTimeoutError({
          message: "Critical query timed out",
          queryKey: ["files", "field_1"],
          timeoutMs: 10_000,
        }),
      ),
    ).toBe(true);
    expect(isNetworkError(new TypeError("Failed to fetch"))).toBe(true);
    expect(
      isNetworkError(
        new TypeError("NetworkError when attempting to fetch resource."),
      ),
    ).toBe(true);
    expect(isNetworkError(new TypeError("Load failed"))).toBe(true);
  });

  test("treats APIError status 0 as transient network failure", () => {
    expect(
      isNetworkError(
        new APIError({
          status: 0,
          message: "Storage fetch failed before response (purpose=display)",
        }),
      ),
    ).toBe(true);
  });

  test("does not classify ordinary API or type errors as network failures", () => {
    expect(
      isNetworkError(new APIError({ status: 500, message: "Server error" })),
    ).toBe(false);
    expect(
      isNetworkError(new TypeError("Cannot read properties of null")),
    ).toBe(false);
  });
});
