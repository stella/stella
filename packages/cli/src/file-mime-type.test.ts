import { describe, expect, test } from "bun:test";

import { inferFileMimeType } from "./file-mime-type.js";

describe("inferFileMimeType", () => {
  test("recognizes common legal document and message formats", () => {
    expect(inferFileMimeType("agreement.pdf")).toBe("application/pdf");
    expect(inferFileMimeType("agreement.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(inferFileMimeType("agreement.txt")).toBe("text/plain");
    expect(inferFileMimeType("email.eml")).toBe("message/rfc822");
    expect(inferFileMimeType("email.msg")).toBe("application/vnd.ms-outlook");
  });

  test("normalizes extension case and falls back only for unknown formats", () => {
    expect(inferFileMimeType("AGREEMENT.PDF")).toBe("application/pdf");
    expect(inferFileMimeType("evidence.unknown")).toBe(
      "application/octet-stream",
    );
    expect(inferFileMimeType("extensionless")).toBe("application/octet-stream");
  });
});
