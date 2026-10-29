import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { normalizeUnicode } from "@stll/text-normalize";

import {
  ArchivePathAllocator,
  compressionForMimeType,
  MAX_SEGMENT_BYTES,
  sanitizeArchiveSegment,
  SEGMENT_SUFFIX_RESERVE,
  truncateUtf8,
  withSegmentSuffix,
} from "@/api/handlers/data-exports/archive-paths";
import { ZIP_COMPRESSION } from "@/api/handlers/data-exports/zip-writer";

// ICU collation checks the fixture equivalence independently of the allocation key.
const filesystemNames = new Intl.Collator("cs", {
  usage: "search",
  sensitivity: "accent",
});

describe("export archive paths", () => {
  test("normalises composed and decomposed names to the same NFC segment", () => {
    const decomposed = "Prohlášení.pdf";
    const composed = "Prohlášení.pdf";
    expect(decomposed).not.toBe(composed);
    expect(sanitizeArchiveSegment(decomposed)).toBe(composed);
  });

  test("renames names that collide only by normalisation or case", () => {
    const allocator = new ArchivePathAllocator();
    const paths = [
      allocator.allocate("m/documents", "Smlouva.pdf"),
      allocator.allocate("m/documents", "SMLOUVA.pdf"),
      allocator.allocate("m/documents", normalizeUnicode("Smlouva.pdf", "NFD")),
      allocator.allocate(
        "m/documents",
        normalizeUnicode("Kupní smlouva.docx", "NFD"),
      ),
      allocator.allocate("m/documents", "Kupní smlouva.docx"),
    ];
    expect(paths).toEqual([
      "m/documents/Smlouva.pdf",
      "m/documents/SMLOUVA (2).pdf",
      "m/documents/Smlouva (3).pdf",
      "m/documents/Kupní smlouva.docx",
      "m/documents/Kupní smlouva (2).docx",
    ]);
  });

  test.each([
    {
      first: "ß.pdf",
      second: "ẞ.pdf",
      firstSuffix: "ß (2).pdf",
      secondSuffix: "ẞ (2).pdf",
    },
    {
      first: "Σ.pdf",
      second: "ς.pdf",
      firstSuffix: "Σ (2).pdf",
      secondSuffix: "ς (2).pdf",
    },
    {
      first: "Smlouva č. 1.pdf",
      second: "Smlouva c\u030c. 1.pdf",
      firstSuffix: "Smlouva č. 1 (2).pdf",
      secondSuffix: "Smlouva č. 1 (2).pdf",
    },
    {
      first: "Ž.docx",
      second: "ž.docx",
      firstSuffix: "Ž (2).docx",
      secondSuffix: "ž (2).docx",
    },
  ])(
    "suffixes filesystem-equivalent names: $first and $second",
    ({ first, second, firstSuffix, secondSuffix }) => {
      expect(first).not.toBe(second);
      expect(filesystemNames.compare(first, second)).toBe(0);
      const allocator = new ArchivePathAllocator();
      expect(allocator.allocate("dir", first)).toBe(`dir/${first}`);
      expect(allocator.allocate("dir", second)).toBe(`dir/${secondSuffix}`);
      const reserved = new ArchivePathAllocator();
      reserved.reserve(`dir/${second}`);
      expect(reserved.allocate("dir", first)).toBe(`dir/${firstSuffix}`);
      expect(() => reserved.reserve(`dir/${first}`)).toThrow(
        "Archive path already allocated",
      );
    },
  );

  test("never lets a file take a reserved path", () => {
    const allocator = new ArchivePathAllocator();
    allocator.reserve("manifest.json");
    expect(allocator.allocate("", "Manifest.JSON")).toBe("Manifest (2).JSON");
    expect(() => allocator.reserve("MANIFEST.json")).toThrow(
      "Archive path already allocated",
    );
  });

  test("neutralises separators, traversal, control characters and device names", () => {
    expect(sanitizeArchiveSegment("../../etc/passwd")).not.toContain("/");
    expect(sanitizeArchiveSegment("a\\b")).toBe("a_b");
    expect(sanitizeArchiveSegment("tab\there")).toBe("tab_here");
    expect(sanitizeArchiveSegment("CON")).toBe("_CON");
    expect(sanitizeArchiveSegment("nul.txt")).toBe("_nul.txt");
    // An empty name falls back to the shared sanitiser's placeholder.
    expect(sanitizeArchiveSegment("   ")).toBe("file");
    expect(sanitizeArchiveSegment("console.log")).toBe("console.log");
  });

  test("allocated paths are NFC, separator-free per segment and unique under case folding", () => {
    const name = fc.string({
      unit: fc.constantFrom(
        "a",
        "A",
        "e",
        "́",
        "é",
        ".",
        "/",
        "\\",
        " ",
        ":",
        "\u0000",
        "ß",
        "ẞ",
        "Σ",
        "σ",
        "ς",
        "Ž",
        "ž",
        "契",
      ),
      maxLength: 12,
    });
    assertProperty(
      "allocated paths are NFC, separator-free per segment and unique under case folding",
      fc.property(fc.array(name, { maxLength: 30 }), (names) => {
        const allocator = new ArchivePathAllocator();
        const paths = names.map((n) => allocator.allocate("dir", n));
        expect(
          paths.every((path, index) =>
            paths
              .slice(index + 1)
              .every((other) => filesystemNames.compare(path, other) !== 0),
          ),
        ).toBe(true);
        for (const path of paths) {
          expect(path).toBe(normalizeUnicode(path, "NFC"));
          expect(path.startsWith("dir/")).toBe(true);
          const segment = path.slice("dir/".length);
          expect(segment).not.toContain("/");
          expect(segment).not.toContain("\\");
          expect(segment).not.toContain("\u0000");
          expect(segment.length).toBeGreaterThan(0);
        }
      }),
    );
  });
});

describe("export file-name length", () => {
  const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
  // Two-byte characters: 300 of them are 600 UTF-8 bytes but only 300
  // UTF-16 units, so a character-count limit would let them through.
  const longCzech = `${"Žluťoučký kůň úpěl ďábelské ódy ".repeat(10)}.docx`;

  test("shortens long names by UTF-8 bytes and keeps the extension", () => {
    expect(bytes(longCzech)).toBeGreaterThan(MAX_SEGMENT_BYTES);
    const segment = sanitizeArchiveSegment(longCzech);
    expect(bytes(segment)).toBeLessThanOrEqual(MAX_SEGMENT_BYTES);
    expect(segment.endsWith(".docx")).toBe(true);
    // Never cuts a character in half.
    expect(segment).toBe(segment.toWellFormed());
  });

  test("keeps version and collision suffixes inside the limit", () => {
    const allocator = new ArchivePathAllocator();
    const versioned = withSegmentSuffix(
      sanitizeArchiveSegment(longCzech),
      " (v12)",
      SEGMENT_SUFFIX_RESERVE.open,
    );
    const paths = [1, 2, 3].map((n) =>
      allocator.allocate("dir", n === 1 ? longCzech : versioned),
    );
    paths.push(allocator.allocate("dir", versioned));
    for (const path of paths) {
      const segment = path.slice("dir/".length);
      expect(bytes(segment)).toBeLessThanOrEqual(MAX_SEGMENT_BYTES);
      expect(segment.endsWith(".docx")).toBe(true);
    }
    expect(paths[1]).toContain(" (v12)");
    expect(paths[2]).toContain(" (v12) (2)");
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("truncates at code-point boundaries", () => {
    expect(truncateUtf8("ž😀a", 2)).toBe("ž");
    expect(truncateUtf8("ž😀a", 5)).toBe("ž");
    expect(truncateUtf8("ž😀a", 6)).toBe("ž😀");
  });
});

describe("export compression choice", () => {
  test("stores already-compressed formats and deflates text", () => {
    expect(compressionForMimeType("application/pdf")).toBe(
      ZIP_COMPRESSION.STORE,
    );
    expect(
      compressionForMimeType(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe(ZIP_COMPRESSION.STORE);
    expect(compressionForMimeType("image/jpeg")).toBe(ZIP_COMPRESSION.STORE);
    expect(compressionForMimeType("text/plain; charset=utf-8")).toBe(
      ZIP_COMPRESSION.DEFLATE,
    );
    expect(compressionForMimeType("application/json")).toBe(
      ZIP_COMPRESSION.DEFLATE,
    );
    expect(compressionForMimeType("message/rfc822")).toBe(
      ZIP_COMPRESSION.DEFLATE,
    );
  });
});
