import { describe, expect, test } from "bun:test";

import { DOCUMENT_UPLOAD_POLICY } from "@stll/api-contract";

import { APIError, shouldRetainPendingEmailUpload } from "@/api";

test("upload timeout covers a maximum-size email at the supported slow rate", () => {
  const minimumTransferMs = Math.ceil(
    (DOCUMENT_UPLOAD_POLICY.maxBytes /
      DOCUMENT_UPLOAD_POLICY.minimumBytesPerSecond) *
      1000,
  );

  expect(DOCUMENT_UPLOAD_POLICY.putTimeoutMs).toBeGreaterThanOrEqual(
    minimumTransferMs,
  );
});

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
    for (const status of [502, 503, 504]) {
      expect(
        shouldRetainPendingEmailUpload(
          new APIError({ message: "gateway response", status }),
        ),
      ).toBe(true);
    }
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
