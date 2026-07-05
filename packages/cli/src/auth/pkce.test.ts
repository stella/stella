import { describe, expect, test } from "bun:test";

import {
  createOAuthState,
  createPkcePair,
  generateCodeChallenge,
} from "./pkce.js";

// RFC 7636 Appendix B's worked example: a fixed verifier and its known-good
// S256 challenge. Pinning this catches any accidental change to the hash
// algorithm/encoding (e.g. swapping base64 for base64url) that unit tests
// against freshly-generated values would never notice.
const RFC_7636_APPENDIX_B_VERIFIER =
  "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_7636_APPENDIX_B_CHALLENGE =
  "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("generateCodeChallenge", () => {
  test("matches the RFC 7636 Appendix B worked example", () => {
    expect(generateCodeChallenge(RFC_7636_APPENDIX_B_VERIFIER)).toBe(
      RFC_7636_APPENDIX_B_CHALLENGE,
    );
  });

  test("is deterministic for a given verifier", () => {
    const verifier = createPkcePair().codeVerifier;
    expect(generateCodeChallenge(verifier)).toBe(
      generateCodeChallenge(verifier),
    );
  });
});

describe("createPkcePair", () => {
  test("codeVerifier uses only the RFC 7636 unreserved charset", () => {
    const { codeVerifier } = createPkcePair();
    expect(codeVerifier).toMatch(/^[A-Za-z0-9\-._~]+$/u);
  });

  test("codeVerifier length falls within RFC 7636's 43-128 bound", () => {
    const { codeVerifier } = createPkcePair();
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeVerifier.length).toBeLessThanOrEqual(128);
  });

  test("codeChallenge is the S256 hash of codeVerifier", () => {
    const { codeChallenge, codeVerifier } = createPkcePair();
    expect(codeChallenge).toBe(generateCodeChallenge(codeVerifier));
  });

  test("generates a fresh verifier on every call", () => {
    const first = createPkcePair();
    const second = createPkcePair();
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
  });
});

describe("createOAuthState", () => {
  test("generates a fresh value on every call", () => {
    expect(createOAuthState()).not.toBe(createOAuthState());
  });

  test("uses a URL-safe charset (no query-string escaping needed)", () => {
    expect(createOAuthState()).toMatch(/^[A-Za-z0-9\-_]+$/u);
  });
});
