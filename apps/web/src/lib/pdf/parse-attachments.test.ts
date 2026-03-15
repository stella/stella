import { describe, expect, it } from "bun:test";

import { parseAttachments } from "@/lib/pdf/parse-attachments";

describe("parseAttachments", () => {
  it("returns empty array when getAttachments() returns null (pdfjs v5.5+)", () => {
    expect(parseAttachments(null)).toEqual([]);
  });

  it("returns empty array when getAttachments() returns undefined (older pdfjs)", () => {
    expect(parseAttachments()).toEqual([]);
  });

  it("filters to PDF attachments with content and filename", () => {
    const result = parseAttachments({
      "file1.pdf": {
        content: new Uint8Array([1, 2, 3]),
        filename: "file1.pdf",
      },
      "image.png": {
        content: new Uint8Array([4, 5]),
        filename: "image.png",
      },
      broken: { filename: "no-content.pdf" },
      "file2.PDF": {
        content: new Uint8Array([6]),
        filename: "file2.PDF",
      },
    });

    expect(result).toHaveLength(2);
    expect(result[0]?.filename).toBe("file1.pdf");
    expect(result[1]?.filename).toBe("file2.PDF");
  });

  it("returns empty array when attachments object has no PDF entries", () => {
    const result = parseAttachments({
      "readme.txt": {
        content: new Uint8Array([1]),
        filename: "readme.txt",
      },
    });

    expect(result).toEqual([]);
  });
});
