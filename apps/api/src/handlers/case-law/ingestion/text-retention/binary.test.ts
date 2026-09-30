import { PDF } from "@libpdf/core";
import { describe, expect, test } from "bun:test";

import { readBinaryText } from "./binary";
import { TEXT_ORACLE_LIMITS } from "./types";

describe("independent binary source text baseline", () => {
  test("all PDF pages and margin text precede court-specific filtering", async () => {
    const pdf = PDF.create();
    pdf.addPage().drawText("HEADER BODY REPEATED REPEATED", { x: 20, y: 700 });
    pdf.addPage().drawText("SECOND PAGE FOOTER", { x: 20, y: 20 });
    const result = await readBinaryText({
      raw: await pdf.save(),
      format: "pdf",
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      throw result.error;
    }
    for (const text of ["HEADER", "BODY", "SECOND PAGE", "FOOTER"]) {
      expect(result.value.text).toContain(text);
    }
    expect(result.value.text.split("REPEATED")).toHaveLength(3);
  });

  test("PDF with no text layer yields no_text_layer rather than an empty baseline", async () => {
    const pdf = PDF.create();
    pdf.addPage();
    const result = await readBinaryText({
      raw: await pdf.save(),
      format: "pdf",
    });
    expect(result.isErr() && result.error.reason).toBe("no_text_layer");
  });

  test("raw size is checked before opening every binary format", async () => {
    const raw = new Uint8Array(TEXT_ORACLE_LIMITS.rawBytes + 1);
    for (const format of ["docx", "pdf", "rtf"] as const) {
      const result = await readBinaryText({ raw, format });
      expect(result.isErr() && result.error.reason).toBe("resource_limit");
    }
  });
});
