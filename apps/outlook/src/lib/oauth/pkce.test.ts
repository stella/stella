import { describe, expect, test } from "bun:test";

import {
  createAuthorizationState,
  createPkcePair,
  deriveCodeChallenge,
} from "@/lib/oauth/pkce";

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

describe("PKCE", () => {
  test("derives the RFC 7636 appendix B challenge", async () => {
    expect(
      await deriveCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("creates a 43-character verifier with its S256 challenge", async () => {
    const pair = await createPkcePair();

    expect(pair.codeVerifier).toHaveLength(43);
    expect(pair.codeVerifier).toMatch(BASE64URL);
    expect(pair.codeChallenge).toBe(
      await deriveCodeChallenge(pair.codeVerifier),
    );
  });

  test("never repeats a verifier or a state", async () => {
    const [first, second] = await Promise.all([
      createPkcePair(),
      createPkcePair(),
    ]);
    expect(first.codeVerifier).not.toBe(second.codeVerifier);

    const state = createAuthorizationState();
    expect(state).toMatch(BASE64URL);
    expect(state.length).toBeGreaterThanOrEqual(43);
    expect(createAuthorizationState()).not.toBe(state);
  });
});
