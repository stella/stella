import { describe, expect, test } from "bun:test";

import { RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS } from "@/api/lib/security-headers";

describe("raw document response security", () => {
  test("prevents sensitive document bytes from being cached", () => {
    const response = new Response(new Uint8Array([1]), {
      headers: RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS,
    });

    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
