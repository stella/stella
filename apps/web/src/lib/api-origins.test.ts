import { describe, expect, test } from "bun:test";

import { mapApiUrlToBrowserBase } from "@/lib/api-origins";

// The deployed shape: the browser calls the API through the web app's own
// `/api` mount, and the public API is a separate origin.
const DEPLOYED = {
  apiOrigin: "https://api.example.test",
  browserApiBase: "https://app.example.test/api",
};

describe("mapApiUrlToBrowserBase", () => {
  test("maps a URL on the public API origin onto the /api mount", () => {
    expect(
      mapApiUrlToBrowserBase(
        "https://api.example.test/v1/file-content/g%2Fx?a=1#h",
        DEPLOYED,
      ),
    ).toBe("https://app.example.test/api/v1/file-content/g%2Fx?a=1#h");
  });

  test("leaves storage and other origins unchanged", () => {
    const presigned =
      "https://bucket.s3.eu-central-1.amazonaws.com/k?X-Amz-Signature=s";
    expect(mapApiUrlToBrowserBase(presigned, DEPLOYED)).toBe(presigned);
    expect(
      mapApiUrlToBrowserBase("https://api.example.test.evil/v1/x", DEPLOYED),
    ).toBe("https://api.example.test.evil/v1/x");
  });

  test("leaves a string that is not a URL unchanged", () => {
    expect(mapApiUrlToBrowserBase("not a url", DEPLOYED)).toBe("not a url");
  });

  test("is the identity without a browser API mount", () => {
    const url = "https://api.example.test/v1/file-content/g";
    expect(
      mapApiUrlToBrowserBase(url, {
        apiOrigin: DEPLOYED.apiOrigin,
        browserApiBase: undefined,
      }),
    ).toBe(url);
  });
});
