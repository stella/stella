import { expect, test } from "bun:test";
import fc from "fast-check";
import JSZip from "jszip";

import {
  assertProperty,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { loadDocxArchive } from "./archive";
import { extractText, loadDocx } from "./zip";
import { writeZipEntry } from "./zip-entry";

// JSZip handles string input in 16 KiB pieces; stream consumers read in
// 64 KiB pieces. Every multiple of either, one code unit on each side,
// is where a split surrogate pair or combining sequence would show up.
const PIECE_SIZES = [16 * 1024, 64 * 1024] as const;
const boundaryOffset = fc
  .tuple(
    fc.constantFrom(...PIECE_SIZES),
    fc.integer({ min: 1, max: 4 }),
    fc.integer({ min: -2, max: 1 }),
  )
  .map(([size, multiple, delta]) => size * multiple + delta);

const ASTRAL = ["\u{1F600}", "\u{1F44D}\u{1F3FD}", "\u{20BB7}", "\u{1D11E}"];
const COMBINING = ["é", "ạ̈", "क्ष"];
const RTL = ["שלום", "مرحبا"];
const edgeText = fc.constantFrom(...ASTRAL, ...COMBINING, ...RTL);
const filler = fc.constantFrom("a", "é", "中", "<w:t>");

const textAtBoundary = fc
  .tuple(
    boundaryOffset,
    filler,
    fc.array(edgeText, { minLength: 1, maxLength: 3 }),
  )
  .map(([offset, unit, edges]) => {
    const prefix = unit
      .repeat(Math.ceil(offset / unit.length))
      .slice(0, offset);
    return prefix + edges.join("") + unit.repeat(32);
  });

const compression = fc.constantFrom("STORE" as const, "DEFLATE" as const);

const roundTrip = async (
  write: (zip: JSZip, text: string) => JSZip,
  text: string,
  method: "STORE" | "DEFLATE",
) => {
  const zip = new JSZip();
  write(zip, text);
  return await zip.generateAsync({ type: "arraybuffer", compression: method });
};

test(
  "text written through the owner reads back unchanged at every piece boundary",
  async () => {
    await assertProperty(
      "text written through the owner reads back unchanged at every piece boundary",
      fc.asyncProperty(textAtBoundary, compression, async (text, method) => {
        const bytes = await roundTrip(
          (zip, value) => writeZipEntry(zip, "word/document.xml", value),
          text,
          method,
        );
        expect(
          await extractText(await loadDocx(bytes), "word/document.xml"),
        ).toBe(text);
        const archive = await loadDocxArchive(bytes);
        expect(await archive.readEntryString("word/document.xml")).toBe(text);
      }),
      { seed: propertySeed(), numRuns: 40 },
    );
  },
  propertyTestTimeout(20_000),
);

test("the property detects JSZip's own string encoding", async () => {
  const text = `${"a".repeat(16 * 1024 - 1)}\u{1F600}tail`;
  const bytes = await roundTrip(
    // oxlint-disable-next-line no-string-zip-entry/no-string-zip-entry -- self-test: the raw string path must fail the round trip
    (zip, value) => zip.file("word/document.xml", value),
    text,
    "STORE",
  );
  expect(
    await extractText(await loadDocx(bytes), "word/document.xml"),
  ).not.toBe(text);
});

test("bytes and buffers pass through unchanged", async () => {
  const zip = new JSZip();
  const bytes = new Uint8Array([0, 255, 1, 128]);
  writeZipEntry(zip, "a.bin", bytes);
  writeZipEntry(zip, "b.bin", bytes.buffer);
  const loaded = await loadDocx(
    await zip.generateAsync({ type: "arraybuffer" }),
  );
  expect(await loaded.file("a.bin")?.async("uint8array")).toEqual(bytes);
  expect(await loaded.file("b.bin")?.async("uint8array")).toEqual(bytes);
});
