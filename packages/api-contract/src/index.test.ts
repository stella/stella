import { describe, expect, test } from "bun:test";

import { buildVersionedApiUrl } from "./index";

describe("REST API contract", () => {
  test("builds the same URL with or without a trailing origin slash", () => {
    expect(buildVersionedApiUrl("https://api.example.com", "/chat")).toBe(
      "https://api.example.com/v1/chat",
    );
    expect(buildVersionedApiUrl("https://api.example.com/", "/chat")).toBe(
      "https://api.example.com/v1/chat",
    );
  });
});
