import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { writeZipEntry } from "@stll/docx-utils";

import { checkConversionInput } from "@/api/lib/files/conversion-input";
import type { ConvertibleMime } from "@/api/lib/files/pdf-derivative-policy";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const zip = async (path: string, value: string): Promise<Uint8Array> =>
  new Uint8Array(
    await writeZipEntry(new JSZip(), path, encode(value)).generateAsync({
      type: "arraybuffer",
    }),
  );

type Fixture = { mime: ConvertibleMime; remote: Uint8Array; local: Uint8Array };

const fixtures = {
  ooxml: {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    remote: await zip(
      "word/_rels/document.xml.rels",
      '<Relationships><Relationship Type="x/oleObject" Target="https://example.test/object" TargetMode="External"/></Relationships>',
    ),
    local: await zip(
      "word/_rels/document.xml.rels",
      '<Relationships><Relationship Type="x/hyperlink" Target="https://example.test/terms" TargetMode="External"/></Relationships>',
    ),
  },
  odf: {
    mime: "application/vnd.oasis.opendocument.text",
    remote: await zip(
      "content.xml",
      '<draw:image xlink:href="https://example.test/image.png"/>',
    ),
    local: await zip(
      "content.xml",
      '<text:a xlink:href="https://example.test/terms">Terms</text:a><draw:image xlink:href="Pictures/a.png"/>',
    ),
  },
  rtf: {
    mime: "application/rtf",
    remote: encode(
      '{\\rtf1{\\field{\\*\\fldinst INCLUDEPICTURE "https://example.test/a.png"}}}',
    ),
    local: encode(
      '{\\rtf1{\\field{\\*\\fldinst HYPERLINK "https://example.test/terms"}}{\\pict 89504e47}}',
    ),
  },
  html: {
    mime: "text/html",
    remote: encode('<img src="https://example.test/a.png">'),
    local: encode(
      '<a href="https://example.test/terms">Terms</a><img src="data:image/png;base64,AA==">',
    ),
  },
  xhtml: {
    mime: "application/xhtml+xml",
    remote: encode(
      "<html><style>@import url(//example.test/a.css)</style></html>",
    ),
    local: encode(
      '<html><a href="https://example.test/terms">Terms</a></html>',
    ),
  },
  doc: {
    mime: "application/msword",
    remote: encode("INCLUDETEXT https://example.test/content"),
    local: encode("HYPERLINK https://example.test/terms"),
  },
} as const satisfies Record<string, Fixture>;

describe("document conversion input", () => {
  test.each(Object.entries(fixtures))(
    "%s refuses remote resources",
    async (_name, fixture) => {
      const result = await checkConversionInput(fixture.mime, fixture.remote);
      expect(result.kind).toBe("refuse");
      if (result.kind === "refuse") {
        expect(result.reason).toBe("external_reference");
      }
    },
  );

  test.each(Object.entries(fixtures))(
    "%s converts documents without remote resources",
    async (_name, fixture) => {
      expect(await checkConversionInput(fixture.mime, fixture.local)).toEqual({
        kind: "convert",
      });
    },
  );

  test("covers every document format outcome", () => {
    const formats = new Set(Object.values(fixtures).map(({ mime }) => mime));
    expect(formats).toEqual(
      new Set([
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.oasis.opendocument.text",
        "application/rtf",
        "application/xhtml+xml",
        "text/html",
      ]),
    );
  });
});
