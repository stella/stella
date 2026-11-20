import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { withoutContentEncryptionKeyForTesting } from "@/api/env-content-encryption";
import { openText, sealText } from "@/api/lib/db/sealed-text";

// `CONTENT_ENCRYPTION_KEY` is set by `tests/setup-env.ts`, so every case runs
// the production cipher.

/** A copy of `source` with one byte changed, so the GCM tag no longer matches. */
const flipByteAt = (source: Buffer, index: number): Buffer => {
  const byte = source.at(index) ?? panic(`no byte at index ${index}`);
  const tampered = Buffer.from(source);
  tampered.set([(byte + 1) % 256], index);
  return tampered;
};

describe("sealed text", () => {
  const scope = "stella:sealed-text:v1:fixture.secret" as const;
  const otherScope = "stella:sealed-text:v1:fixture.other" as const;
  const secret = JSON.stringify({ value: "fixture-sealed-value" });

  test("opens what it sealed, and every seal of one value differs", () => {
    const first = sealText(scope, secret).unwrap();
    const second = sealText(scope, secret).unwrap();

    expect(first).not.toBe(second);
    expect(first).not.toContain("fixture-sealed-value");
    expect(first.split(".")).toHaveLength(4);
    expect(openText(scope, first).unwrap()).toBe(secret);
    expect(openText(scope, second).unwrap()).toBe(secret);
  });

  test("text sealed under one scope opens under no other", () => {
    const sealed = sealText(scope, secret).unwrap();

    expect(Result.isError(openText(otherScope, sealed))).toBe(true);
  });

  test("refuses tampered, truncated and foreign envelopes", () => {
    const sealed = sealText(scope, secret).unwrap();
    const [version, keyId, iv, payload] = sealed.split(".");
    if (payload === undefined || iv === undefined || keyId === undefined) {
      return panic("sealed text has four parts");
    }
    const tampered = flipByteAt(Buffer.from(payload, "base64url"), 0);
    const cases = [
      [
        version,
        keyId,
        iv,
        tampered.toBase64({ alphabet: "base64url", omitPadding: true }),
      ].join("."),
      [version, keyId, iv, payload.slice(0, 8)].join("."),
      ["v0", keyId, iv, payload].join("."),
      [version, "AAAAAAAA", iv, payload].join("."),
      [version, keyId, payload].join("."),
      secret,
    ];
    for (const stored of cases) {
      expect(Result.isError(openText(scope, stored)), stored).toBe(true);
    }
  });

  test("never seals or opens without the content key", () => {
    const sealed = sealText(scope, secret).unwrap();
    const restore = withoutContentEncryptionKeyForTesting();
    try {
      const refusedSeal = sealText(scope, secret);
      const refusedOpen = openText(scope, sealed);
      expect(
        Result.isError(refusedSeal) && refusedSeal.error.message,
      ).toContain("CONTENT_ENCRYPTION_KEY");
      expect(
        Result.isError(refusedOpen) && refusedOpen.error.message,
      ).toContain("CONTENT_ENCRYPTION_KEY");
    } finally {
      restore();
    }
  });
});
