import { makeSignature } from "better-auth/crypto";
import { expect, test } from "bun:test";

import { createSignedSessionCookieValue } from "@/api/lib/auth/signed-session-cookie";

test("the cookie value matches better-auth's session signature", async () => {
  const token = "session-token-fixture";
  const secret = "better-auth-session-secret-fixture";

  expect(createSignedSessionCookieValue(token, secret)).toBe(
    `${token}.${await makeSignature(token, secret)}`,
  );
});
