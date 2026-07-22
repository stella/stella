import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import JSZip from "jszip";

import { propertyConfig } from "@stll/property-testing";

import { findUnusedTemplateValueKeys } from "./template-input-contract";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const makeTemplate = async (): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="${W_NS}"><w:body>` +
      `<w:p><w:r><w:t>{{name}}</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>{{company.name}}</w:t></w:r></w:p>` +
      `</w:body></w:document>`,
  );
  return await zip.generateAsync({ type: "nodebuffer" });
};

describe("template input contract", () => {
  test("accepts top-level and flattened declared paths", async () => {
    expect(
      await findUnusedTemplateValueKeys({
        buffer: await makeTemplate(),
        values: { name: "Ada", company: { name: "Stella" } },
      }),
    ).toEqual([]);
    expect(
      await findUnusedTemplateValueKeys({
        buffer: await makeTemplate(),
        values: { "company.name": "Stella" },
      }),
    ).toEqual([]);
  });

  test("rejects extra keys independently of every supported value type", async () => {
    expect(
      await findUnusedTemplateValueKeys({
        buffer: await makeTemplate(),
        values: {
          name: "Ada",
          typoString: "value",
          typoNumber: 1,
          typoBoolean: true,
          typoArray: ["value"],
          typoObject: { nested: "value" },
        },
      }),
    ).toEqual([
      "typoString",
      "typoNumber",
      "typoBoolean",
      "typoArray",
      "typoObject",
    ]);
  });

  test("INVARIANT: value shape cannot change whether an unknown key is rejected", async () => {
    const buffer = await makeTemplate();
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (value) => {
        expect(
          await findUnusedTemplateValueKeys({
            buffer,
            values: { unknown: value },
          }),
        ).toEqual(["unknown"]);
      }),
      propertyConfig,
    );
  });
});
