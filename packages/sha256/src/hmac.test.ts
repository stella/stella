import { expect, test } from "bun:test";

import { hmacSha256Hex } from "./hmac.ts";

test("HMAC-SHA-256 matches the RFC 4231 vector", () => {
  expect(
    hmacSha256Hex(
      new TextEncoder().encode("Jefe"),
      "what do ya want for nothing?",
    ),
  ).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
});
