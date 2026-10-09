import { expect, test } from "bun:test";
import fc from "fast-check";

import * as browser from "@stll/sha256/browser";
import * as bun from "@stll/sha256/bun";
import * as node from "@stll/sha256/node";

import { assertProperty } from "./index";

const PROPERTY_ID =
  "SHA-256 owners preserve bytes and arbitrary stream partitions";

test(PROPERTY_ID, async () => {
  await assertProperty(
    PROPERTY_ID,
    fc.asyncProperty(
      fc.uint8Array({ maxLength: 8192 }),
      fc.integer({ min: 1, max: 1024 }),
      fc.integer({ min: 1, max: 32 }),
      async (bytes, chunkSize, prefixSize) => {
        const storage = new Uint8Array(bytes.length + prefixSize + 7).fill(255);
        storage.set(bytes, prefixSize);
        const view = storage.subarray(prefixSize, prefixSize + bytes.length);
        const expected = node.sha256Bytes(bytes);
        for (const owner of [bun, node]) {
          expect(owner.sha256Bytes(view)).toEqual(expected);
          expect(owner.sha256Hex(view)).toBe(expected.toString("hex"));
          expect(owner.sha256Base64(view)).toBe(expected.toString("base64"));
          expect(owner.sha256Base64Url(view)).toBe(
            expected.toString("base64url"),
          );
          const hasher = owner.createSha256();
          for (let offset = 0; offset < view.length; offset += chunkSize) {
            hasher.update(view.subarray(offset, offset + chunkSize));
          }
          expect(hasher.digest()).toEqual(expected);
        }
        expect(await browser.sha256Hex(view)).toBe(expected.toString("hex"));
        expect(new Uint8Array(await browser.sha256Bytes(view))).toEqual(
          new Uint8Array(expected),
        );
      },
    ),
    { seed: 260_106, numRuns: 100 },
  );
});

const TEXT_PROPERTY_ID =
  "SHA-256 owners preserve arbitrary UTF-16 text and fragment encodings";

const utf16Text = fc
  .array(fc.integer({ min: 0, max: 65_535 }), { maxLength: 1024 })
  .map((units) => units.map((unit) => String.fromCodePoint(unit)).join(""));

test(TEXT_PROPERTY_ID, async () => {
  await assertProperty(
    TEXT_PROPERTY_ID,
    fc.asyncProperty(
      fc.record({
        text: utf16Text,
        chunkSize: fc.integer({ min: 1, max: 64 }),
      }),
      async ({ text, chunkSize }) => {
        const expected = node.sha256Bytes(text);
        for (const owner of [bun, node]) {
          expect(owner.sha256Bytes(text)).toEqual(expected);
          expect(owner.sha256Hex(text)).toBe(expected.toString("hex"));
          expect(owner.sha256Base64(text)).toBe(expected.toString("base64"));
          expect(owner.sha256Base64Url(text)).toBe(
            expected.toString("base64url"),
          );
        }
        expect(await browser.sha256Hex(text)).toBe(expected.toString("hex"));
        expect(new Uint8Array(await browser.sha256Bytes(text))).toEqual(
          new Uint8Array(expected),
        );

        const bunFragments = bun.createSha256();
        const nodeFragments = node.createSha256();
        const encodedFragments = node.createSha256();
        const fragmentBytes: Uint8Array[] = [];
        for (let offset = 0; offset < text.length; offset += chunkSize) {
          const fragment = text.slice(offset, offset + chunkSize);
          const bytes = new TextEncoder().encode(fragment);
          bunFragments.update(fragment);
          nodeFragments.update(fragment);
          encodedFragments.update(bytes);
          fragmentBytes.push(bytes);
        }
        // Each update encodes its own UTF-16 fragment. A split surrogate pair
        // therefore becomes two replacement characters, unlike one-shot text.
        const expectedFragments = encodedFragments.digest();
        expect(bunFragments.digest()).toEqual(expectedFragments);
        expect(nodeFragments.digest()).toEqual(expectedFragments);
        expect(
          new Uint8Array(
            await browser.sha256Bytes(Buffer.concat(fragmentBytes)),
          ),
        ).toEqual(new Uint8Array(expectedFragments));
      },
    ),
    {
      seed: 260_107,
      numRuns: 100,
      examples: [
        [{ text: "\ud83d\ude00", chunkSize: 1 }],
        [{ text: "\ud800x\udfff", chunkSize: 2 }],
      ],
    },
  );
});
