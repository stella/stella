import { describe, expect, test } from "bun:test";

import { isUploadRateLimitedPath } from "@/api/handlers/entities/upload-rate-limit";

describe("entity upload rate limiting", () => {
  test("covers original and version upload endpoints", () => {
    expect(isUploadRateLimitedPath("/v1/entities/ws_1/upload")).toBe(true);
    expect(isUploadRateLimitedPath("/v1/entities/ws_1/upload/")).toBe(true);
    expect(isUploadRateLimitedPath("/v1/entities/ws_1/upload-version")).toBe(
      true,
    );
    expect(isUploadRateLimitedPath("/v1/entities/ws_1/upload-version/")).toBe(
      true,
    );
  });

  test("does not cover non-upload entity endpoints", () => {
    expect(isUploadRateLimitedPath("/v1/entities/ws_1/query")).toBe(false);
    expect(isUploadRateLimitedPath("/v1/entities/ws_1/entity/ent_1")).toBe(
      false,
    );
    expect(
      isUploadRateLimitedPath("/v1/entities/ws_1/upload-version/extra"),
    ).toBe(false);
  });
});
