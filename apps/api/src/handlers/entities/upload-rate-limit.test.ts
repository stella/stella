import { describe, expect, test } from "bun:test";

import { isUploadRateLimitedPath } from "@/api/lib/upload-rate-limit";

describe("document write rate limiting", () => {
  test("covers every endpoint that stores new document bytes", () => {
    expect(isUploadRateLimitedPath("/v1/entities/ws_1/upload")).toBe(true);
    expect(isUploadRateLimitedPath("/v1/entities/ws_1/upload/")).toBe(true);
    expect(
      isUploadRateLimitedPath("/v1/entities/ws_1/upload-generated-document"),
    ).toBe(true);
    expect(
      isUploadRateLimitedPath("/v1/entities/ws_1/upload-generated-document/"),
    ).toBe(true);
    expect(isUploadRateLimitedPath("/v1/entities/ws_1/upload-version")).toBe(
      true,
    );
    expect(isUploadRateLimitedPath("/v1/entities/ws_1/upload-version/")).toBe(
      true,
    );
    expect(
      isUploadRateLimitedPath(
        "/v1/files/ws_1/email-attachment/field_1/ea1.token/save",
      ),
    ).toBe(false);
    expect(
      isUploadRateLimitedPath(
        "/v1/files/ws_1/email-attachment/field_1/ea1.token/save/",
      ),
    ).toBe(false);
  });

  test("does not cover non-upload entity endpoints", () => {
    expect(isUploadRateLimitedPath("/v1/entities/ws_1/query")).toBe(false);
    expect(isUploadRateLimitedPath("/v1/entities/ws_1/entity/ent_1")).toBe(
      false,
    );
    expect(
      isUploadRateLimitedPath("/v1/entities/ws_1/upload-version/extra"),
    ).toBe(false);
    expect(
      isUploadRateLimitedPath(
        "/v1/entities/ws_1/upload-generated-document/extra",
      ),
    ).toBe(false);
    expect(
      isUploadRateLimitedPath(
        "/v1/files/ws_1/email-attachment/field_1/ea1.token/preview",
      ),
    ).toBe(false);
  });
});
