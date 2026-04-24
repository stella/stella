import { describe, expect, test } from "bun:test";

import type { SanitizedFileName } from "./sanitize-filename";
import { DOCX_EXT_RE, sanitizeFilename } from "./sanitize-filename";

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

  test("returns a SanitizedFileName branded type", () => {
    const result = sanitizeFilename("normal.pdf");
    // Compile-time check: result is assignable to SanitizedFileName
    const _branded: SanitizedFileName = result;
    expect(typeof _branded).toBe("string");
  });
});

describe("DOCX_EXT_RE", () => {
  test("matches trailing docx extension case-insensitively", () => {
    expect(DOCX_EXT_RE.test("template.DOCX")).toBe(true);
    expect(DOCX_EXT_RE.test("template.doc")).toBe(false);
  });
});
