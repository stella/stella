import { describe, expect, test } from "bun:test";

import { scanTemplateOutput } from "./validate-template-output";

describe("template conversion input", () => {
  test("rejects bytes that are not a DOCX package", async () => {
    expect(
      await scanTemplateOutput({
        buffer: new TextEncoder().encode("not a docx"),
        fileName: "template.docx",
      }),
    ).toBeNull();
  });
});
