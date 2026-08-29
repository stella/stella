import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { decryptContent, encryptContent } from "@/api/lib/content-encryption";

/**
 * Behavioural coverage for the real AES-256-GCM envelope. `CONTENT_ENCRYPTION_KEY`
 * is set by `tests/setup-env.ts`, so every case below runs the production cipher.
 *
 * Not covered: the `ConfigurationError` raised when the master key is absent at
 * decrypt time. The key is read through the validated `envDocumentProcessingWorker`
 * object, which is built once from `process.env` at import; exercising the missing-key
 * branch would mean mutating that module's export for the whole shared test process.
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

    expect(await decryptContent(organizationId, ciphertext, iv)).toBe(
      plaintext,
    );
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

    await expect(
      decryptContent(otherOrganizationId, ciphertext, iv),
    ).rejects.toThrow(DOMException);
  });

  test("encrypts the same plaintext to different ciphertext per organization", async () => {
    const mine = await encryptContent(organizationId, plaintext);
    const theirs = await encryptContent(otherOrganizationId, plaintext);

    expect(mine.ciphertext.equals(theirs.ciphertext)).toBe(false);
  });

  test("rejects a tampered ciphertext body", async () => {
    const { ciphertext, iv } = await encryptContent(organizationId, plaintext);

    await expect(
      decryptContent(organizationId, flipByteAt(ciphertext, 0), iv),
    ).rejects.toThrow(DOMException);
  });

  test("rejects a tampered auth tag (the trailing 16 bytes)", async () => {
    const { ciphertext, iv } = await encryptContent(organizationId, plaintext);

    await expect(
      decryptContent(
        organizationId,
        flipByteAt(ciphertext, ciphertext.length - 1),
        iv,
      ),
    ).rejects.toThrow(DOMException);
  });

  test("rejects a truncated ciphertext (auth tag stripped)", async () => {
    const { ciphertext, iv } = await encryptContent(organizationId, plaintext);

    await expect(
      decryptContent(organizationId, ciphertext.subarray(0, 4), iv),
    ).rejects.toThrow(DOMException);
  });

  test("rejects a mismatched IV", async () => {
    const { ciphertext } = await encryptContent(organizationId, plaintext);
    const { iv: otherIv } = await encryptContent(organizationId, plaintext);

    await expect(
      decryptContent(organizationId, ciphertext, otherIv),
    ).rejects.toThrow(DOMException);
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
