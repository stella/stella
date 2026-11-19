import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";
import { sha256Hex } from "@stll/sha256/bun";

import { withoutContentEncryptionKeyForTesting } from "@/api/env-content-encryption";
import { toSafeId } from "@/api/lib/branded-types";
import {
  contentLookupKey,
  decryptContent,
  encryptContent,
  keyedContentLookupKey,
  openText,
  sealText,
} from "@/api/lib/content-encryption";
import { runWithQueryCounter } from "@/api/lib/db-query-counter";
import { currentReadWork } from "@/api/lib/observability/request-work";

/**
 * Behavioural coverage for the real AES-256-GCM envelope. `CONTENT_ENCRYPTION_KEY`
 * is set by `tests/setup-env.ts`, so every case below runs the production cipher.
 *
 * The separate environment subprocess test covers strict missing-key refusal
 * without changing this process's shared encryption settings.
 */

const organizationId = toSafeId<"organization">(
  "0191d14d-9a63-7d2e-a021-06053e542c85",
);
const otherOrganizationId = toSafeId<"organization">(
  "0191d14d-9a63-7d2e-a021-06053e542c86",
);
const plaintext = "Clause 4.2 — indemnity, Kč 1 000 000, řádně a včas.";

/** A copy of `source` with one byte changed, so the GCM tag no longer matches. */
const flipByteAt = (source: Buffer, index: number): Buffer => {
  const byte = source.at(index);
  if (byte === undefined) {
    throw new Error(`ciphertext has no byte at index ${index}`);
  }
  const tampered = Buffer.from(source);
  tampered.set([(byte + 1) % 256], index);
  return tampered;
};

describe("encryptContent / decryptContent", () => {
  test("roundtrips a payload for the same organization", async () => {
    const { ciphertext, iv } = await encryptContent(organizationId, plaintext);

    await runWithQueryCounter(async () => {
      expect(await decryptContent(organizationId, ciphertext, iv)).toBe(
        plaintext,
      );
      expect(currentReadWork()?.decryptedBytes).toBe(
        Buffer.byteLength(plaintext),
      );
    });
  });

  test("roundtrips an empty payload", async () => {
    const { ciphertext, iv } = await encryptContent(organizationId, "");

    expect(await decryptContent(organizationId, ciphertext, iv)).toBe("");
  });

  test("stores ciphertext, never the plaintext bytes", async () => {
    const { ciphertext, iv } = await encryptContent(organizationId, plaintext);

    expect(ciphertext.toString("utf-8")).not.toBe(plaintext);
    expect(ciphertext.includes(Buffer.from(plaintext, "utf-8"))).toBe(false);
    // A 12-byte zero IV marks the no-op plaintext envelope used when no master
    // key is configured; the encrypting path must never mint one.
    expect(iv.every((byte) => byte === 0)).toBe(false);
    expect(iv).toHaveLength(12);
  });

  test("produces a fresh IV and distinct ciphertext for identical input", async () => {
    const first = await encryptContent(organizationId, plaintext);
    const second = await encryptContent(organizationId, plaintext);

    expect(first.iv.equals(second.iv)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    expect(
      await decryptContent(organizationId, first.ciphertext, first.iv),
    ).toBe(await decryptContent(organizationId, second.ciphertext, second.iv));
  });

  test("separates tenants: another organization cannot decrypt", async () => {
    const { ciphertext, iv } = await encryptContent(organizationId, plaintext);

    expect(
      await rejectionOf(decryptContent(otherOrganizationId, ciphertext, iv)),
    ).toBeInstanceOf(DOMException);
  });

  test("encrypts the same plaintext to different ciphertext per organization", async () => {
    const mine = await encryptContent(organizationId, plaintext);
    const theirs = await encryptContent(otherOrganizationId, plaintext);

    expect(mine.ciphertext.equals(theirs.ciphertext)).toBe(false);
  });

  test("rejects a tampered ciphertext body", async () => {
    const { ciphertext, iv } = await encryptContent(organizationId, plaintext);

    expect(
      await rejectionOf(
        decryptContent(organizationId, flipByteAt(ciphertext, 0), iv),
      ),
    ).toBeInstanceOf(DOMException);
  });

  test("rejects a tampered auth tag (the trailing 16 bytes)", async () => {
    const { ciphertext, iv } = await encryptContent(organizationId, plaintext);

    expect(
      await rejectionOf(
        decryptContent(
          organizationId,
          flipByteAt(ciphertext, ciphertext.length - 1),
          iv,
        ),
      ),
    ).toBeInstanceOf(DOMException);
  });

  test("rejects a truncated ciphertext (auth tag stripped)", async () => {
    const { ciphertext, iv } = await encryptContent(organizationId, plaintext);

    expect(
      await rejectionOf(
        decryptContent(organizationId, ciphertext.subarray(0, 4), iv),
      ),
    ).toBeInstanceOf(DOMException);
  });

  test("rejects a mismatched IV", async () => {
    const { ciphertext } = await encryptContent(organizationId, plaintext);
    const { iv: otherIv } = await encryptContent(organizationId, plaintext);

    expect(
      await rejectionOf(decryptContent(organizationId, ciphertext, otherIv)),
    ).toBeInstanceOf(DOMException);
  });

  test("reads a zero-IV envelope back as stored plaintext", async () => {
    // Rows written before a master key existed carry an all-zero IV; they must
    // keep reading back as UTF-8 rather than failing decryption.
    expect(
      await decryptContent(
        organizationId,
        Buffer.from(plaintext, "utf-8"),
        Buffer.alloc(12),
      ),
    ).toBe(plaintext);
  });
});

describe("contentLookupKey", () => {
  test("is stable for one value, so equal entries meet without decryption", async () => {
    expect(await contentLookupKey(organizationId, plaintext)).toBe(
      await contentLookupKey(organizationId, plaintext),
    );
    expect(await contentLookupKey(organizationId, plaintext)).toMatch(
      /^[0-9a-f]{64}$/u,
    );
  });

  test("tells different values apart and never carries the plaintext", async () => {
    const key = await contentLookupKey(organizationId, plaintext);

    expect(await contentLookupKey(organizationId, `${plaintext} `)).not.toBe(
      key,
    );
    expect(key).not.toContain(Buffer.from(plaintext).toHex());
  });

  test("separates tenants: one value hashes differently per organization", async () => {
    expect(await contentLookupKey(organizationId, plaintext)).not.toBe(
      await contentLookupKey(otherOrganizationId, plaintext),
    );
  });
});

describe("sealed text", () => {
  const scope = "stella:sealed-text:v1:fixture.secret" as const;
  const otherScope = "stella:sealed-text:v1:fixture.other" as const;
  const secret = JSON.stringify({ clientSecret: "fixture-client-secret" });

  test("opens what it sealed, and every seal of one value differs", () => {
    const first = sealText(scope, secret).unwrap();
    const second = sealText(scope, secret).unwrap();

    expect(first).not.toBe(second);
    expect(first).not.toContain("fixture-client-secret");
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
      throw new Error("sealed text has four parts");
    }
    const tampered = flipByteAt(Buffer.from(payload, "base64url"), 0);
    const cases = [
      [version, keyId, iv, tampered.toString("base64url")].join("."),
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

test("required keyed identifiers preserve the keyed format and never equal the public digest", async () => {
  const identifier = (
    await keyedContentLookupKey(organizationId, plaintext)
  ).unwrap();
  expect(identifier).toBe(await contentLookupKey(organizationId, plaintext));
  expect(identifier).not.toBe(sha256Hex(`${organizationId}\u0000${plaintext}`));
});
