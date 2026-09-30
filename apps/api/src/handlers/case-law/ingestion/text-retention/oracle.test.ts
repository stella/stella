import { PDF } from "@libpdf/core";
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { listSourceRegistrations } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";

import { compareRetention } from "./compare";
import { readTextBaseline } from "./oracle";
import { TEXT_FORMAT, type TextFormat } from "./types";

const raw = (text: string) => new TextEncoder().encode(text);
const fixtureText = "SOURCE repeated repeated 123";

/** Every oracle input variant has a golden fixture, including binary text layers. */
const FORMAT_FIXTURES = {
  [TEXT_FORMAT.HTML]: async () => ({
    format: TEXT_FORMAT.HTML,
    raw: raw(`<p>${fixtureText}</p>`),
  }),
  [TEXT_FORMAT.XML]: async () => ({
    format: TEXT_FORMAT.XML,
    raw: raw(`<root><p>${fixtureText}</p></root>`),
  }),
  [TEXT_FORMAT.TEXT]: async () => ({
    format: TEXT_FORMAT.TEXT,
    raw: raw(fixtureText),
  }),
  [TEXT_FORMAT.JSON]: async () => ({
    format: TEXT_FORMAT.JSON,
    raw: raw(JSON.stringify({ body: fixtureText })),
    fields: [{ path: ["body"], format: TEXT_FORMAT.TEXT }],
  }),
  [TEXT_FORMAT.RTF]: async () => ({
    format: TEXT_FORMAT.RTF,
    raw: raw(`{\\rtf1 ${fixtureText}}`),
  }),
  [TEXT_FORMAT.DOCX]: async () => {
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${fixtureText}</w:t></w:r></w:p></w:body></w:document>`,
    );
    return {
      format: TEXT_FORMAT.DOCX,
      raw: await zip.generateAsync({ type: "uint8array" }),
    };
  },
  [TEXT_FORMAT.PDF]: async () => {
    const pdf = PDF.create();
    pdf.addPage().drawText(fixtureText, { x: 20, y: 700 });
    return { format: TEXT_FORMAT.PDF, raw: await pdf.save() };
  },
} as const satisfies Record<
  TextFormat,
  () => Promise<Parameters<typeof readTextBaseline>[0]>
>;

describe("format oracle boundary", () => {
  for (const format of Object.values(TEXT_FORMAT)) {
    test(`${format} preserves the golden text through its independent oracle`, async () => {
      const result = await readTextBaseline(await FORMAT_FIXTURES[format]());
      expect(
        compareRetention({
          source: fixtureText,
          output: result.unwrap().text,
        }).unwrap(),
      ).toMatchObject({ status: "assessed", defect: null, retainedRatio: 1 });
    });
  }

  test("each registered format branch has an executable golden oracle", () => {
    for (const { format } of listSourceRegistrations()) {
      for (const branch of format.branches) {
        expect(Object.hasOwn(FORMAT_FIXTURES, branch.format)).toBe(true);
      }
    }
  });

  test("text decoding rejects invalid UTF-8", async () => {
    expect(
      (
        await readTextBaseline({ format: "text", raw: Uint8Array.of(255) })
      ).unwrapErr().reason,
    ).toBe("malformed");
  });
});
