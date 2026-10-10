import { expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";
import { sha256Hex as hashContent, createSha256 } from "@stll/sha256/node";

import { sourceFingerprint } from "./source-fingerprint";

const objectsOf = (sidecars: readonly Uint8Array[]) =>
  Object.fromEntries(
    sidecars.map((bytes, index) => [
      `object-${String(index)}`,
      { bytes, contentType: "application/octet-stream" },
    ]),
  );

/** Shift one byte by `delta` (1..255), which always changes it. */
const flipped = (bytes: Uint8Array, at: number, delta: number): Uint8Array => {
  const copy = bytes.slice();
  const index = at % copy.length;
  copy[index] = ((copy[index] ?? 0) + delta) % 256;
  return copy;
};

test("changing one byte of the envelope or of any stored object changes the fingerprint", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1 }),
      fc.array(fc.uint8Array({ minLength: 1, maxLength: 64 }), {
        maxLength: 4,
      }),
      fc.nat(),
      fc.nat(),
      fc.integer({ min: 1, max: 255 }),
      (sourceRaw, sidecars, target, at, mask) => {
        const before = sourceFingerprint({
          sourceRaw,
          sourceRawObjects: objectsOf(sidecars),
        });
        const part = target % (sidecars.length + 1);
        const after =
          part === 0
            ? sourceFingerprint({
                sourceRaw: new TextDecoder().decode(
                  flipped(new TextEncoder().encode(sourceRaw), at, mask),
                ),
                sourceRawObjects: objectsOf(sidecars),
              })
            : sourceFingerprint({
                sourceRaw,
                sourceRawObjects: objectsOf(
                  sidecars.map((bytes, index) =>
                    index === part - 1 ? flipped(bytes, at, mask) : bytes,
                  ),
                ),
              });
        // A flip inside a multi-byte character can decode to the same
        // replacement character; only a changed stored value must differ.
        if (part === 0) {
          const changed = new TextDecoder().decode(
            flipped(new TextEncoder().encode(sourceRaw), at, mask),
          );
          if (changed === sourceRaw) {
            return;
          }
        }
        expect(after).not.toBe(before);
      },
    ),
    propertyConfig({ numRuns: 300 }),
  );
});

test("an envelope with no objects keeps the digest adapters already store", () => {
  fc.assert(
    fc.property(fc.string(), (sourceRaw) => {
      expect<string>(sourceFingerprint({ sourceRaw })).toBe(
        hashContent(sourceRaw),
      );
      expect<string>(
        sourceFingerprint({ sourceRaw, sourceRawObjects: {} }),
      ).toBe(hashContent(sourceRaw));
    }),
    propertyConfig({ numRuns: 200 }),
  );
});

test("objects contribute the digest of their bytes in the order they are listed", () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const pdfDigest = createSha256().update(pdf).digest("hex");
  expect<string>(
    sourceFingerprint({
      sourceRaw: "envelope",
      sourceRawObjects: {
        pdf: { bytes: pdf, contentType: "application/pdf" },
      },
    }),
  ).toBe(hashContent(`envelope\n${pdfDigest}`));
});
