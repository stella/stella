import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  createPkcePair,
  deriveCodeChallenge,
  encodeBase64Url,
  type AuthorizationCrypto,
} from "./pkce";
import { webCrypto } from "./test-support/web-crypto";

const decodeBase64Url = (text: string): Uint8Array =>
  Uint8Array.from(
    atob(text.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.codePointAt(0) ?? 0,
  );

describe("PKCE", () => {
  test("derives the RFC 7636 Appendix B challenge", async () => {
    expect(
      await deriveCodeChallenge(
        webCrypto,
        "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      ),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("base64url encoding round-trips and uses only the URL-safe alphabet", () => {
    assertProperty(
      "base64url encoding round-trips and uses only the URL-safe alphabet",
      fc.property(fc.uint8Array({ maxLength: 96 }), (bytes) => {
        const encoded = encodeBase64Url(bytes);
        expect(encoded).toMatch(/^[\w-]*$/u);
        expect(decodeBase64Url(encoded)).toEqual(bytes);
      }),
    );
  });

  test("a verifier is the 43-character form RFC 7636 §4.1 recommends", async () => {
    const pair = await createPkcePair(webCrypto);
    expect(pair.codeVerifier).toMatch(/^[\w-]{43}$/u);
    expect(pair.codeChallenge).toBe(
      await deriveCodeChallenge(webCrypto, pair.codeVerifier),
    );
  });

  test("each pair draws fresh randomness", async () => {
    let draws = 0;
    const counting: AuthorizationCrypto = {
      ...webCrypto,
      randomBytes: (length) => {
        draws += 1;
        return webCrypto.randomBytes(length);
      },
    };
    const first = await createPkcePair(counting);
    const second = await createPkcePair(counting);
    expect(draws).toBe(2);
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
  });
});
