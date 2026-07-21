import { describe, expect, test } from "bun:test";

import {
  buildVersionedApiUrl,
  STELLA_API_VERSION_PREFIX,
  STELLA_REST_API_CONTRACT_VERSION,
} from "./index";

describe("REST API contract", () => {
  test("keeps the version prefix and contract number explicit", () => {
    expect(STELLA_API_VERSION_PREFIX).toBe("/v1");
    expect(STELLA_REST_API_CONTRACT_VERSION).toBe(1);
  });

  test("builds the same URL with or without a trailing origin slash", () => {
    expect(buildVersionedApiUrl("https://api.example.com", "/chat")).toBe(
      "https://api.example.com/v1/chat",
    );
    expect(buildVersionedApiUrl("https://api.example.com/", "/chat")).toBe(
      "https://api.example.com/v1/chat",
    );
  });
});
