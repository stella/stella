import { describe, expect, test } from "bun:test";

import { isStyleSetUploadRateLimitedRequest } from "@/api/handlers/style-sets/upload-rate-limit";

const request = (method: string, path: string) => ({
  method,
  url: `https://stella.example${path}`,
});

describe("style set upload rate-limit routing", () => {
  test("matches create and replace uploads", () => {
    expect(
      isStyleSetUploadRateLimitedRequest(request("PUT", "/v1/style-sets")),
    ).toBe(true);
    expect(
      isStyleSetUploadRateLimitedRequest(
        request("POST", "/v1/style-sets/style-set-id/source"),
      ),
    ).toBe(true);
  });

  test("leaves non-upload style-set requests in the shared API bucket", () => {
    expect(
      isStyleSetUploadRateLimitedRequest(
        request("POST", "/v1/style-sets/style-set-id"),
      ),
    ).toBe(false);
    expect(
      isStyleSetUploadRateLimitedRequest(request("GET", "/v1/style-sets")),
    ).toBe(false);
  });
});
