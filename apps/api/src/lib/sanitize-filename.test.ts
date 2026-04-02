import { describe, expect, test } from "bun:test";

import { DOCX_EXT_RE, sanitizeFilename } from "./sanitize-filename";

describe("sanitizeFilename", () => {
  test("replaces control and header-unsafe characters", () => {
    expect(sanitizeFilename('evil\r\n"name?.pdf')).toBe("evil___name_.pdf");
  });

  test("neutralizes path traversal segments", () => {
    expect(sanitizeFilename("../contracts/../../secret.docx")).toBe(
      "___contracts_______secret.docx",
    );
  });

  test("replaces leading and trailing dots after sanitization", () => {
    expect(sanitizeFilename("...draft...")).toBe("__.draft___");
  });
});

describe("DOCX_EXT_RE", () => {
  test("matches trailing docx extension case-insensitively", () => {
    expect(DOCX_EXT_RE.test("template.DOCX")).toBe(true);
    expect(DOCX_EXT_RE.test("template.doc")).toBe(false);
  });
});
