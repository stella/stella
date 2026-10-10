/**
 * The upload scan's compound-file warning is skipped only for the exact
 * encrypted Office layout; any other directory keeps it.
 */
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import path from "node:path";

import { assertProperty } from "@stll/property-testing";

import { scanFile } from "@/api/lib/file-scan/scan";
import { isExactEncryptedOoxmlLayout } from "@/api/lib/files/encrypted-ooxml";
import {
  DOCX_MIME_TYPE,
  PDF_MIME_TYPE,
  PPTX_MIME_TYPE,
  XLSX_MIME_TYPE,
} from "@/api/mime-types";

import {
  buildCompoundFile,
  detachChildren,
  injectDirectoryEntry,
} from "./compound-file.test-fixture";
import type { CompoundFileFixtureStream } from "./compound-file.test-fixture";

const OLE2_RULE = "ole2_container";
const DATA_SPACES = "\u0006DataSpaces";

const REAL_FIXTURES = [
  { format: "docx", mimeType: DOCX_MIME_TYPE },
  { format: "xlsx", mimeType: XLSX_MIME_TYPE },
  { format: "pptx", mimeType: PPTX_MIME_TYPE },
] as const;

const readFixture = async (format: string): Promise<Uint8Array> =>
  new Uint8Array(
    await Bun.file(
      path.join(
        import.meta.dir,
        "__fixtures__",
        `password-protected-${format}.cfb`,
      ),
    ).arrayBuffer(),
  );

const scanRules = async (
  bytes: Uint8Array,
  mimeType: string,
): Promise<string[]> =>
  (
    await scanFile({
      buffer: bytes,
      declaredMimeType: mimeType,
      fileName: "fixture",
    })
  )
    .unwrap()
    .findings.map((finding) => finding.rule);

/** The streams of the layout; storages follow from their paths. */
const LAYOUT_STREAMS: readonly (readonly string[])[] = [
  ["EncryptionInfo"],
  ["EncryptedPackage"],
  [DATA_SPACES, "Version"],
  [DATA_SPACES, "DataSpaceMap"],
  [DATA_SPACES, "DataSpaceInfo", "StrongEncryptionDataSpace"],
  [DATA_SPACES, "TransformInfo", "StrongEncryptionTransform", "\u0006Primary"],
];

const layoutStreams = (): CompoundFileFixtureStream[] =>
  LAYOUT_STREAMS.map((streamPath) => ({
    path: [...streamPath],
    bytes: new Uint8Array([1, 2, 3, 4]),
  }));

const LAYOUT_STORAGE_PATHS: readonly (readonly string[])[] = [
  [],
  [DATA_SPACES],
  [DATA_SPACES, "DataSpaceInfo"],
  [DATA_SPACES, "TransformInfo"],
  [DATA_SPACES, "TransformInfo", "StrongEncryptionTransform"],
];

describe("compound-file scan warning", () => {
  for (const { format, mimeType } of REAL_FIXTURES) {
    test(`is skipped for a password-protected ${format}`, async () => {
      const bytes = await readFixture(format);

      expect(isExactEncryptedOoxmlLayout(mimeType, bytes)).toBe(true);
      expect(await scanRules(bytes, mimeType)).not.toContain(OLE2_RULE);
    });
  }

  const injections = [
    { parentName: "Root Entry", name: "Macros", kind: "storage" },
    { parentName: "Root Entry", name: "_VBA_PROJECT", kind: "stream" },
    { parentName: "Root Entry", name: "ObjectPool", kind: "storage" },
    { parentName: "Root Entry", name: "\u0001Ole10Native", kind: "stream" },
    { parentName: "Root Entry", name: "WordDocument", kind: "stream" },
    {
      parentName: "Root Entry",
      name: "\u0005SummaryInformation",
      kind: "stream",
    },
    { parentName: DATA_SPACES, name: "Extra", kind: "stream" },
    { parentName: "StrongEncryptionTransform", name: "VBA", kind: "storage" },
  ] as const;
  for (const injection of injections) {
    test(`stays when a protected file also holds ${JSON.stringify(injection.name)} under ${JSON.stringify(injection.parentName)}`, async () => {
      const bytes = injectDirectoryEntry(await readFixture("docx"), injection);

      expect(isExactEncryptedOoxmlLayout(DOCX_MIME_TYPE, bytes)).toBe(false);
      expect(await scanRules(bytes, DOCX_MIME_TYPE)).toContain(OLE2_RULE);
    });
  }

  test("is skipped for the synthetic layout and stays when any stream is missing", async () => {
    expect(
      isExactEncryptedOoxmlLayout(
        DOCX_MIME_TYPE,
        buildCompoundFile(layoutStreams()),
      ),
    ).toBe(true);
    for (const missing of LAYOUT_STREAMS) {
      const bytes = buildCompoundFile(
        layoutStreams().filter(
          (entry) => entry.path.join("/") !== missing.join("/"),
        ),
      );
      expect(isExactEncryptedOoxmlLayout(DOCX_MIME_TYPE, bytes)).toBe(false);
      // Without an encryption stream the file is not an encrypted package at
      // all and the scan refuses it; otherwise it warns.
      expect(await scanRules(bytes, DOCX_MIME_TYPE)).toContain(
        missing.length === 1 ? "corrupt-zip" : OLE2_RULE,
      );
    }
  });

  for (const storageName of [
    DATA_SPACES,
    "DataSpaceInfo",
    "TransformInfo",
    "StrongEncryptionTransform",
  ]) {
    test(`stays for a real fixture whose ${JSON.stringify(storageName)} lost its children`, async () => {
      const bytes = detachChildren(await readFixture("docx"), storageName);

      expect(isExactEncryptedOoxmlLayout(DOCX_MIME_TYPE, bytes)).toBe(false);
      expect(await scanRules(bytes, DOCX_MIME_TYPE)).toContain(OLE2_RULE);
    });
  }

  test("stays for the exact layout declared as a non-Office type", () => {
    expect(
      isExactEncryptedOoxmlLayout(
        PDF_MIME_TYPE,
        buildCompoundFile(layoutStreams()),
      ),
    ).toBe(false);
    expect(
      isExactEncryptedOoxmlLayout(
        "application/zip",
        buildCompoundFile(layoutStreams()),
      ),
    ).toBe(false);
  });

  test("any extra entry, at any depth, keeps the warning", () => {
    const entryName = fc
      .string({ minLength: 1, maxLength: 31 })
      .filter((name) => !name.includes("\u0000"));
    assertProperty(
      "any extra entry, at any depth, keeps the warning",
      fc.property(
        fc.constantFrom(...LAYOUT_STORAGE_PATHS),
        fc.array(entryName, { maxLength: 3 }),
        entryName,
        fc.constantFrom("storage" as const, "stream" as const),
        (parent, newStorages, name, kind) => {
          const extraPath = [...parent, ...newStorages, name];
          const extraKey = JSON.stringify([kind, ...extraPath]);
          const layoutKeys = new Set([
            ...LAYOUT_STREAMS.map((entry) =>
              JSON.stringify(["stream", ...entry]),
            ),
            ...LAYOUT_STORAGE_PATHS.filter((entry) => entry.length > 0).map(
              (entry) => JSON.stringify(["storage", ...entry]),
            ),
          ]);
          // An "extra" storage the layout already has adds nothing.
          fc.pre(!layoutKeys.has(extraKey));

          const bytes = buildCompoundFile([
            ...layoutStreams(),
            { path: extraPath, bytes: new Uint8Array([9]), kind },
          ]);
          expect(isExactEncryptedOoxmlLayout(DOCX_MIME_TYPE, bytes)).toBe(
            false,
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});
