import { describe, expect, test } from "bun:test";

import type { SanitizedFileName } from "./sanitize-filename";
import {
  DOCX_EXT_RE,
  sanitizeFilename,
  sanitizeFilenamePreservingExtension,
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
});

describe("DOCX_EXT_RE", () => {
  test("matches trailing docx extension case-insensitively", () => {
    expect(DOCX_EXT_RE.test("template.DOCX")).toBe(true);
    expect(DOCX_EXT_RE.test("template.doc")).toBe(false);
  });
});
