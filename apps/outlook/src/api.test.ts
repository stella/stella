import { describe, expect, test } from "bun:test";

import { APIError, shouldRetainPendingEmailUpload } from "@/api";

describe("pending email finalize retry", () => {
  test("retains the upload after uncertain and retryable failures", () => {
    expect(shouldRetainPendingEmailUpload(new DOMException("timeout"))).toBe(
      true,
    );
    expect(
      shouldRetainPendingEmailUpload(
        new APIError({ message: "in progress", status: 409 }),
      ),
    ).toBe(true);
    expect(
      shouldRetainPendingEmailUpload(
        new APIError({ message: "temporary", status: 500 }),
      ),
    ).toBe(true);
  });

  test("releases the upload after a terminal finalize response", () => {
    expect(
      shouldRetainPendingEmailUpload(
        new APIError({ message: "missing", status: 404 }),
      ),
    ).toBe(false);
    expect(
      shouldRetainPendingEmailUpload(
        new APIError({ message: "rejected", status: 422 }),
      ),
    ).toBe(false);
  });
});
