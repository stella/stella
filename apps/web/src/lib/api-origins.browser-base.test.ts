import { describe, expect, test } from "bun:test";

// The deployed shape: the browser calls the API through the web app's own
// `/api` mount, and the public API is a separate origin.
const APP_ORIGIN = "https://app.example.test";
Object.assign(import.meta.env, {
  VITE_API_URL: "https://api.example.test",
  VITE_BROWSER_API_URL: `${APP_ORIGIN}/api`,
  VITE_PUBLIC_APP_URL: APP_ORIGIN,
});

const { toBrowserApiUrl } = await import("@/lib/api-origins");

describe("toBrowserApiUrl with a same-origin API mount", () => {
  test("maps a URL on the public API origin onto the /api mount", () => {
    expect(
      toBrowserApiUrl("https://api.example.test/v1/file-content/g%2Fx?a=1#h"),
    ).toBe(`${APP_ORIGIN}/api/v1/file-content/g%2Fx?a=1#h`);
  });

  test("leaves storage and other origins unchanged", () => {
    const presigned =
      "https://bucket.s3.eu-central-1.amazonaws.com/k?X-Amz-Signature=s";
    expect(toBrowserApiUrl(presigned)).toBe(presigned);
    expect(toBrowserApiUrl("https://api.example.test.evil/v1/x")).toBe(
      "https://api.example.test.evil/v1/x",
    );
  });

  test("leaves a string that is not a URL unchanged", () => {
    expect(toBrowserApiUrl("not a url")).toBe("not a url");
  });
});
