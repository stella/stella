import { describe, expect, test } from "bun:test";

import { decodeAccessTokenClaims } from "./jwt.js";

const encodeSegment = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const createUnsignedJwt = (payload: unknown): string =>
  `${encodeSegment({ alg: "none", typ: "JWT" })}.${encodeSegment(payload)}.signature`;

describe("decodeAccessTokenClaims", () => {
  test("accepts provider JWTs with extra claims", () => {
    const claims = decodeAccessTokenClaims(
      createUnsignedJwt({
        sub: "user_123",
        org_id: "org_123",
        scope: "openid stella:read",
        exp: 1_783_551_200,
        iat: 1_783_550_000,
        aud: "http://localhost:3001/mcp",
        azp: "client_123",
        iss: "http://localhost:3001/api/auth",
        sid: "session_123",
      }),
    );

    expect(claims?.org_id).toBe("org_123");
  });
});
