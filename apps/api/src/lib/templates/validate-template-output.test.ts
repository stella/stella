import { describe, expect, test } from "bun:test";

import { isTemplateOutputValid } from "./validate-template-output";

describe("template conversion input", () => {
  test("rejects bytes that are not a DOCX package", async () => {
    expect(
      await isTemplateOutputValid({
        buffer: new TextEncoder().encode("not a docx"),
        fileName: "template.docx",
      }),
    ).toBe(false);
  });
});
