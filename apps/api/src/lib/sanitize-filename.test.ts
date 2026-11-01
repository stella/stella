import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { SanitizedFileName } from "./sanitize-filename";
import {
  DOCX_EXT_RE,
  sanitizeFilename,
  sanitizeFilenamePreservingExtension,
  stripInvisibleFormatting,
} from "./sanitize-filename";

describe("sanitizeFilename", () => {
  test("replaces control and header-unsafe characters", () => {
    expect<string>(sanitizeFilename('evil\r\n"name?.pdf')).toBe(
      "evil___name_.pdf",
    );
  });

  test("neutralizes path traversal segments", () => {
    expect<string>(sanitizeFilename("../contracts/../../secret.docx")).toBe(
      "___contracts_______secret.docx",
    );
  });

  test("replaces leading and trailing dots after sanitization", () => {
    expect<string>(sanitizeFilename("...draft...")).toBe("__.draft___");
  });

  test("does not double-count a single dot filename", () => {
    expect<string>(sanitizeFilename(".")).toBe("_");
  });

  test("returns a SanitizedFileName branded type", () => {
    const result = sanitizeFilename("normal.pdf");
    // Compile-time check: result is assignable to SanitizedFileName
    const _branded: SanitizedFileName = result;
    expect(typeof _branded).toBe("string");
  });

  test("truncates at Unicode code-point boundaries", () => {
    const result = sanitizeFilename(`${"a".repeat(253)}😀z`);

    expect(result).toHaveLength(255);
    expect(result.endsWith("😀")).toBe(true);
    expect(() => encodeURIComponent(result)).not.toThrow();
  });

  test("bounds astral filenames by UTF-16 length", () => {
    const result = sanitizeFilename("😀".repeat(255));

    expect(result).toHaveLength(254);
    expect(Array.from(result)).toHaveLength(127);
    expect(() => encodeURIComponent(result)).not.toThrow();
  });

  test("replaces an existing unpaired surrogate", () => {
    const result = sanitizeFilename(`${"a".repeat(254)}\uD83Dx`);

    expect(result.endsWith("�")).toBe(true);
    expect(() => encodeURIComponent(result)).not.toThrow();
  });

  test("preserves the DOCX extension when truncating a long name", () => {
    const fileName = sanitizeFilenamePreservingExtension(
      `${"a".repeat(256)}.docx`,
    );

    expect(fileName).toHaveLength(255);
    expect(fileName.endsWith(".docx")).toBe(true);
  });

  test("removes format characters and keeps letters", () => {
    expect<string>(sanitizeFilename("a\u202Etxt.pdf")).toBe("atxt.pdf");
    expect<string>(
      sanitizeFilename("\u200E\u200F\u2066a\u2069\u00AD\u200B.pdf"),
    ).toBe("a.pdf");
    expect<string>(sanitizeFilename("Příloha č. 1.docx")).toBe(
      "Příloha č. 1.docx",
    );
    expect<string>(sanitizeFilename("شلום.pdf")).toBe("شلום.pdf");
  });

  test("checks traversal after format characters are gone", () => {
    expect<string>(sanitizeFilename("a.\u202E.b")).toBe("a__b");
  });

  test("falls back when only format characters remain", () => {
    expect<string>(sanitizeFilename("\u202E\u200F")).toBe("file");
  });

  test("the extension-preserving form treats the extension the same way", () => {
    expect<string>(
      sanitizeFilenamePreservingExtension("a\u202E.t\u202Ext"),
    ).toBe("a.txt");
    expect<string>(
      sanitizeFilenamePreservingExtension(
        `${"a".repeat(260)}.d\u200Bo\u200Bc\u200Bx`,
      ),
    ).toBe(`${"a".repeat(250)}.docx`);
  });

  test("no format character but a joiner survives either form", () => {
    assertProperty(
      "no format character but a joiner survives either form",
      fc.property(fc.string({ unit: "binary" }), (name) => {
        for (const sanitized of [
          sanitizeFilename(name),
          sanitizeFilenamePreservingExtension(name),
        ]) {
          expect(sanitized.replaceAll(/[\u200C\u200D]/gu, "")).not.toMatch(
            /\p{Cf}/u,
          );
        }
      }),
    );
  });
});

describe("stripInvisibleFormatting", () => {
  test.each([
    "\u00AD",
    "\u061C",
    "\u200B",
    "\u200E",
    "\u200F",
    "\u202A",
    "\u202B",
    "\u202C",
    "\u202D",
    "\u202E",
    "\u2060",
    "\u2066",
    "\u2067",
    "\u2068",
    "\u2069",
    "\uFEFF",
  ])("removes format character %#", (character) => {
    expect(character).toMatch(/\p{Cf}/u);
    expect(stripInvisibleFormatting(`a${character}b.txt`)).toBe("ab.txt");
  });

  test("removes tag characters outside the basic plane", () => {
    expect(stripInvisibleFormatting("a\u{E0041}b")).toBe("ab");
  });

  test.each([
    "Smlouva o dílo č. 12 – příloha.docx",
    "ژاله-قرارداد.pdf",
    "שלום עולם.docx",
    "عقد الإيجار.pdf",
    "می\u200Cخواهم.docx",
    "क्\u200Dष.pdf",
    "👨\u200D👩\u200D👧.txt",
  ])("keeps %s unchanged", (name) => {
    expect(stripInvisibleFormatting(name)).toBe(name);
  });
});

describe("DOCX_EXT_RE", () => {
  test("matches trailing docx extension case-insensitively", () => {
    expect(DOCX_EXT_RE.test("template.DOCX")).toBe(true);
    expect(DOCX_EXT_RE.test("template.doc")).toBe(false);
  });
});
