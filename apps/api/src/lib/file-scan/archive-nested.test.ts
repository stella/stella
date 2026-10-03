import { expect, test } from "bun:test";
import fc from "fast-check";
import JSZip from "jszip";

import { assertProperty } from "@stll/property-testing";

import { createArchiveContentScanner } from "./archive";
import type { WindowedRuleSet } from "./yara";
import { hasZipMagic } from "./zip";

const MARKER = Buffer.from("sample-field-value");
const rules = {
  maxMatchBytes: MARKER.length,
  countingRules: new Set<string>(),
  occurrences: (window: Uint8Array) => {
    const bytes = Buffer.from(window);
    const occurrences = [];
    for (
      let offset = bytes.indexOf(MARKER);
      offset >= 0;
      offset = bytes.indexOf(MARKER, offset + 1)
    ) {
      occurrences.push({
        rule: "sample_field",
        pattern: "value",
        offset,
        length: MARKER.length,
      });
    }
    return occurrences;
  },
  evaluate: (rule: string, evidence: Uint8Array) =>
    Buffer.from(evidence).includes(MARKER)
      ? { rule, severity: "suspicious" }
      : null,
} satisfies WindowedRuleSet;
const scanner = createArchiveContentScanner({
  rules,
  budget: {
    windowBytes: 64,
    maxNestedEntryBytes: 1024 * 1024,
    maxTotalInflatedBytes: 1024 * 1024 * 1024,
    maxEvidenceBytes: 1024,
    timeBudgetMs: 60_000,
  },
  guard: { scan: async () => [] },
});
const packageOf = async (parts: readonly Buffer[]) => {
  const zip = new JSZip();
  for (const [index, part] of parts.entries()) {
    zip.file(
      index === 0 ? "word/document.xml" : `word/part${index}.xml`,
      part,
      { createFolders: false },
    );
  }
  return await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
};
const wrap = async (bytes: Buffer) => {
  const zip = new JSZip();
  zip.file("word/altChunk.docx", bytes, { createFolders: false });
  return await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
};
const matchRules = async (bytes: Buffer) =>
  (await scanner.scan(bytes)).map(({ rule }) => rule);

test("inspects a packaged document field", async () => {
  const inner = await packageOf([
    Buffer.from(
      `<w:document><w:instrText>${MARKER}</w:instrText></w:document>`,
    ),
  ]);
  expect(await matchRules(await wrap(inner))).toEqual(["sample_field"]);
});
test("accepts two nested package levels and enforces the nesting limit", async () => {
  const inner = await packageOf([Buffer.from("<w:document/>")]);
  const two = await wrap(await wrap(inner));
  expect(await matchRules(two)).toEqual([]);
  expect(await matchRules(await wrap(two))).toEqual(["archive-nesting-limit"]);
});
test("requires a contiguous local entry layout", async () => {
  const bytes = await packageOf([
    Buffer.from("<a/>"),
    Buffer.from("<b/>"),
    Buffer.from("<c/>"),
  ]);
  const eocd = bytes.length - 22;
  const central = bytes.readUInt32LE(eocd + 16);
  const recordEnd = (start: number) =>
    start +
    46 +
    bytes.readUInt16LE(start + 28) +
    bytes.readUInt16LE(start + 30) +
    bytes.readUInt16LE(start + 32);
  const second = recordEnd(central);
  const third = recordEnd(second);
  const edited = Buffer.concat([
    bytes.subarray(0, second),
    bytes.subarray(third),
  ]);
  const newEnd = edited.length - 22;
  edited.writeUInt16LE(2, newEnd + 8);
  edited.writeUInt16LE(2, newEnd + 10);
  edited.writeUInt32LE(
    bytes.readUInt32LE(eocd + 12) - (third - second),
    newEnd + 12,
  );
  expect(await matchRules(bytes)).toEqual([]);
  expect(await matchRules(edited)).toEqual(["archive-corrupt"]);
});
test("requires package magic at the start", async () => {
  const bytes = await packageOf([Buffer.from("<w:document/>")]);
  expect(hasZipMagic(bytes)).toBe(true);
  expect(hasZipMagic(Buffer.concat([Buffer.alloc(16, 0x61), bytes]))).toBe(
    false,
  );
});
test("finds sample fields throughout package parts", async () => {
  await assertProperty(
    "finds sample fields throughout package parts",
    fc.asyncProperty(
      fc.array(fc.integer({ min: 1, max: 512 }), {
        minLength: 1,
        maxLength: 5,
      }),
      fc.nat(),
      fc.nat(),
      fc.integer({ min: 0, max: 2 }),
      async (lengths, selected, position, depth) => {
        const parts = lengths.map((length) =>
          Buffer.from(`<w:document>${"a".repeat(length)}</w:document>`),
        );
        const index = selected % parts.length;
        const part = parts.at(index);
        if (part === undefined) {
          throw new Error("Expected a generated part");
        }
        const offset =
          "<w:document>".length +
          (position % (part.length - "<w:document></w:document>".length + 1));
        parts[index] = Buffer.concat([
          part.subarray(0, offset),
          MARKER,
          part.subarray(offset),
        ]);
        let bytes = await packageOf(parts);
        for (let level = 0; level < depth; level++) {
          bytes = await wrap(bytes);
        }
        expect(await matchRules(bytes)).toEqual(["sample_field"]);
      },
    ),
  );
});

test("finds packaged fields at each window offset", async () => {
  for (let offset = 0; offset < 64; offset++) {
    const inner = await packageOf([
      Buffer.concat([
        Buffer.alloc(offset, 0x61),
        MARKER,
        Buffer.alloc(64, 0x61),
      ]),
    ]);
    expect(await matchRules(await wrap(inner))).toEqual(["sample_field"]);
  }
});

test("shares evidence limits between package levels", async () => {
  const limited = createArchiveContentScanner({
    rules: { ...rules, countingRules: new Set(["sample_field"]) },
    budget: {
      windowBytes: 64,
      maxNestedEntryBytes: 1024 * 1024,
      maxTotalInflatedBytes: 1024 * 1024 * 1024,
      maxEvidenceBytes: MARKER.length,
      timeBudgetMs: 60_000,
    },
    guard: { scan: async () => [] },
  });
  const zip = new JSZip();
  zip.file("word/document.xml", MARKER, { createFolders: false });
  zip.file("word/altChunk.docx", await packageOf([MARKER]), {
    createFolders: false,
  });
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
  expect((await limited.scan(bytes)).map(({ rule }) => rule)).toEqual([
    "archive-inspection-budget",
  ]);
});

test("shares the deadline between package levels", async () => {
  let ticks = 0;
  const limited = createArchiveContentScanner({
    rules,
    budget: {
      windowBytes: 64,
      maxNestedEntryBytes: 1024 * 1024,
      maxTotalInflatedBytes: 1024 * 1024 * 1024,
      maxEvidenceBytes: 1024,
      timeBudgetMs: 5,
    },
    guard: { scan: async () => [] },
    now: () => ticks++,
  });
  const bytes = await wrap(await packageOf([Buffer.from("<w:document/>")]));
  expect((await limited.scan(bytes)).map(({ rule }) => rule)).toEqual([
    "archive-inspection-budget",
  ]);
});

test("enforces the packaged entry size limit", async () => {
  const inner = await packageOf([Buffer.from("<w:document/>")]);
  const limited = createArchiveContentScanner({
    rules,
    budget: {
      windowBytes: 64,
      maxEvidenceBytes: 1024,
      timeBudgetMs: 60_000,
      maxNestedEntryBytes: inner.length - 1,
      maxTotalInflatedBytes: 1024 * 1024,
    },
    guard: { scan: async () => [] },
  });
  expect(
    (await limited.scan(await wrap(inner))).map(({ rule }) => rule),
  ).toEqual(["archive-inflation-limit"]);
});

test("uses the index refusal for a packaged index outside its limits", async () => {
  const outer = await wrap(await packageOf([Buffer.from("<w:document/>")]));
  const limited = createArchiveContentScanner({
    rules,
    budget: {
      windowBytes: 64,
      maxEvidenceBytes: 1024,
      timeBudgetMs: 60_000,
      maxNestedEntryBytes: 1024 * 1024,
      maxTotalInflatedBytes: 1024 * 1024,
    },
    guard: {
      scan: async (bytes) =>
        bytes === outer
          ? []
          : [{ rule: "sample_index_limit", severity: "critical" }],
    },
  });
  expect((await limited.scan(outer)).map(({ rule }) => rule)).toEqual([
    "archive-nested-index-refused",
  ]);
});

test("shares the total inflated size limit between package levels", async () => {
  const part = Buffer.from(`<w:document>${"a".repeat(128)}</w:document>`);
  const inner = await packageOf([part]);
  const limited = createArchiveContentScanner({
    rules,
    budget: {
      windowBytes: 64,
      maxEvidenceBytes: 1024,
      timeBudgetMs: 60_000,
      maxNestedEntryBytes: 1024 * 1024,
      maxTotalInflatedBytes: inner.length + part.length - 1,
    },
    guard: { scan: async () => [] },
  });
  expect(await matchRules(await wrap(inner))).toEqual([]);
  expect(
    (await limited.scan(await wrap(inner))).map(({ rule }) => rule),
  ).toEqual(["archive-inflation-limit"]);
});
