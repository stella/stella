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

const binaryField = (instruction: string): Uint8Array =>
  new Uint8Array([0x13, ...encode(instruction), 0x14]);

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
      '{\\rtf1 important{\\field{\\*\\fldinst HYPERLINK "https://example.test/terms"}}{\\pict 89504e47}}',
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
    remote: binaryField("INCLUDETEXT https://example.test/content"),
    local: encode("important link HYPERLINK https://example.test/terms"),
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

  test.each([
    '<img src="&#104;ttp&colon;//example.test/a.png">',
    '<img src="ht\tp://example.test/a.png">',
    '<img src="\\\\example.test\\a.png">',
    '<img src="smb://example.test/a.png">',
  ])("refuses non-local HTML references", async (source) => {
    expect(await checkConversionInput("text/html", encode(source))).toEqual({
      kind: "refuse",
      reason: "external_reference",
      format: "text/html",
    });
  });

  test("refuses OOXML field instructions for remote content", async () => {
    const input = await zip(
      "word/document.xml",
      "<w:document><w:instrText>INCLUDEPICTURE https://example.test/a.png</w:instrText></w:document>",
    );
    expect(
      await checkConversionInput(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        input,
      ),
    ).toEqual({
      kind: "refuse",
      reason: "external_reference",
      format:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  });

  test("converts a DOCX with a large document body", async () => {
    const paragraph = "<w:p><w:r><w:t>ordinary text</w:t></w:r></w:p>";
    const input = await zip(
      "word/document.xml",
      `<w:document>${paragraph.repeat(70_000)}</w:document>`,
    );
    expect(
      await checkConversionInput(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        input,
      ),
    ).toEqual({ kind: "convert" });
  });

  test("refuses OOXML field instructions joined across runs", async () => {
    const input = await zip(
      "word/document.xml",
      '<w:document><w:fldChar w:fldCharType="begin"/><w:r><w:instrText>INCLUDE</w:instrText></w:r><w:r><w:instrText>PICTURE "http://x.invalid/a.png"</w:instrText></w:r><w:fldChar w:fldCharType="end"/></w:document>',
    );
    expect(
      await checkConversionInput(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        input,
      ),
    ).toEqual({
      kind: "refuse",
      reason: "external_reference",
      format:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  });

  test("refuses RTF field instructions without a destination marker", async () => {
    const input = encode(
      '{\\field{\\fldinst INCLUDEPICTURE "http://x.invalid/a.png"}}',
    );
    expect(await checkConversionInput("application/rtf", input)).toEqual({
      kind: "refuse",
      reason: "external_reference",
      format: "application/rtf",
    });
  });

  test("counts RTF braces after escaped backslashes", async () => {
    const input = encode(
      '{\\field{\\fldinst HYPERLINK "local" \\\\{ INCLUDEPICTURE "http://x.invalid/a.png"}}{\\fldinst INCLUDETEXT "http://x.invalid/body"}}',
    );
    expect(await checkConversionInput("application/rtf", input)).toEqual({
      kind: "refuse",
      reason: "external_reference",
      format: "application/rtf",
    });
  });

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
