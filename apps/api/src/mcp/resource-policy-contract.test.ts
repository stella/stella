import { describe, expect, test } from "bun:test";

import {
  buildBetterAuthOAuthResources,
  normalizeBetterAuthOAuthBaseUrl,
} from "@/api/mcp/resource-policy-contract";

describe("Better Auth OAuth resource policy contract", () => {
  test("derives every resource from an explicit origin", () => {
    expect(
      buildBetterAuthOAuthResources("https://api.stll.app").map(
        ({ identifier }) => identifier,
      ),
    ).toEqual([
      "https://api.stll.app/mcp",
      "https://api.stll.app/mcp-documents",
      "https://api.stll.app/mcp-anonymized",
    ]);
  });

  test("accepts only a credential-free HTTPS origin", () => {
    expect(normalizeBetterAuthOAuthBaseUrl("https://api.stll.app/")).toBe(
      "https://api.stll.app",
    );
    for (const value of [
      "http://api.stll.app",
      "https://user:secret@api.stll.app",
      "https://api.stll.app/path",
      "https://api.stll.app?query=1",
      "https://api.stll.app#fragment",
      "not-a-url",
    ]) {
      expect(normalizeBetterAuthOAuthBaseUrl(value)).toBeNull();
    }
  });
});
