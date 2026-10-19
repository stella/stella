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
      '<Relationships><Relationship Type="x/hyperlink" Target="notes.xml"/></Relationships>',
    ),
  },
  odf: {
    mime: "application/vnd.oasis.opendocument.text",
    remote: await zip(
      "content.xml",
      '<content xmlns:draw="urn:draw" xmlns:xlink="urn:xlink"><draw:image xlink:href="https://example.test/image.png"/></content>',
    ),
    local: await zip(
      "content.xml",
      '<content xmlns:text="urn:text" xmlns:draw="urn:draw" xmlns:xlink="urn:xlink"><text:a xlink:href="https://example.test/terms">Terms</text:a><draw:image xlink:href="Pictures/a.png"/></content>',
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

  test.each([
    '<img alt=">" src="https://example.test/a.png">',
    "<img alt='>' src='https://example.test/a.png'>",
    '<img alt="&#x3e;" src="https://example.test/a.png">',
    "<img SRC=https://example.test/a.png>",
    '<div style="background:url(//x.test/a)"></div>',
    '<svg><use href="https://x.test/s#a"></use></svg>',
    '<link HREF="https://example.test/a.css">',
  ])("refuses references in parsed HTML attributes", async (source) => {
    expect(await checkConversionInput("text/html", encode(source))).toEqual({
      kind: "refuse",
      reason: "external_reference",
      format: "text/html",
    });
  });

  test.each([
    '<a href="https://x.test">link</a>',
    '<img src="data:image/png;base64,AA==">',
    '<img src="relative.png">',
    '<svg><use href="#icon"></use></svg>',
  ])("allows local and navigation HTML references", async (source) => {
    expect(await checkConversionInput("text/html", encode(source))).toEqual({
      kind: "convert",
    });
  });

  test.each([
    "<style>@import   </style>",
    "<style>body{background:url(   </style>",
  ])("refuses unfinished CSS references", async (source) => {
    const result = await Promise.race([
      checkConversionInput("text/html", encode(source)),
      Bun.sleep(1000).then(() => "timeout"),
    ]);
    expect(result).not.toBe("timeout");
    expect(result).toEqual({
      kind: "refuse",
      reason: "external_reference",
      format: "text/html",
    });
  });

  test.each([
    '<Relationships><Relationship TargetMode="External" Target="local.xml"/></Relationships>',
    "<Relationships><Relationship target='https://example.test/a' type='x' targetmode='internal'/></Relationships>",
  ])("refuses non-local OOXML relationships", async (relationship) => {
    const input = await zip("word/_rels/document.xml.rels", relationship);
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

  test("refuses OOXML field instructions for remote content", async () => {
    const input = await zip(
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:instrText>INCLUDEPICTURE https://example.test/a.png</w:instrText></w:document>',
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

  test.each([
    '<q:document xmlns:q="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><q:fldSimple q:instr="INCLUDEPICTURE https://example.test/a.png"/></q:document>',
    '<q:document xmlns:q="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><q:fldChar q:fldCharType="begin"/><q:instrText>INCLUDEPICTURE https://example.test/a.png</q:instrText><q:fldChar q:fldCharType="end"/></q:document>',
  ])("refuses OOXML field instructions by namespace", async (document) => {
    const input = await zip("word/document.xml", document);
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

  test.each([
    '<q:document xmlns:q="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><q:fldSimple q:instr="PAGE"/></q:document>',
    '<q:document xmlns:q="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><q:fldChar q:fldCharType="begin"/><q:instrText>TOC \\o &quot;1-3&quot;</q:instrText><q:fldChar q:fldCharType="end"/></q:document>',
  ])("converts allowed OOXML fields by namespace", async (document) => {
    const input = await zip("word/document.xml", document);
    expect(
      await checkConversionInput(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        input,
      ),
    ).toEqual({ kind: "convert" });
  });

  test("converts a DOCX with a large document body", async () => {
    const paragraph = "<w:p><w:r><w:t>ordinary text</w:t></w:r></w:p>";
    const input = await zip(
      "word/document.xml",
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${paragraph.repeat(70_000)}</w:document>`,
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
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:fldChar w:fldCharType="begin"/><w:r><w:instrText>INCLUDE</w:instrText></w:r><w:r><w:instrText>PICTURE "http://x.invalid/a.png"</w:instrText></w:r><w:fldChar w:fldCharType="end"/></w:document>',
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

  test("refuses OOXML instructions joined around a nested field", async () => {
    const input = await zip(
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:fldChar w:fldCharType="begin"/><w:instrText>INCLUDE</w:instrText><w:fldChar w:fldCharType="begin"/><w:instrText>PAGE</w:instrText><w:fldChar w:fldCharType="separate"/><w:t>1</w:t><w:fldChar w:fldCharType="end"/><w:instrText>PICTURE "http://x.invalid/a.png"</w:instrText><w:fldChar w:fldCharType="separate"/><w:fldChar w:fldCharType="end"/></w:document>',
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

  test("converts ordinary nested OOXML fields", async () => {
    const input = await zip(
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:fldChar w:fldCharType="begin"/><w:instrText>IF </w:instrText><w:fldChar w:fldCharType="begin"/><w:instrText>PAGE</w:instrText><w:fldChar w:fldCharType="separate"/><w:t>1</w:t><w:fldChar w:fldCharType="end"/><w:instrText> = 1 "first" "later"</w:instrText><w:fldChar w:fldCharType="separate"/><w:t>first</w:t><w:fldChar w:fldCharType="end"/></w:document>',
    );
    expect(
      await checkConversionInput(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        input,
      ),
    ).toEqual({ kind: "convert" });
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

  test.each([
    String.raw`{\rtf1{\field{\*\fldinst \'49NCLUDEPICTURE "https://example.test/a.png"}}}`,
    String.raw`{\rtf1{\field{\*\fldinst \u73?NCLUDEPICTURE "https://example.test/a.png"}}}`,
    String.raw`{\rtf1{\field{\*\fldinst {\b INCLUDE}{PICTURE "https://example.test/a.png"}}}}`,
    String.raw`{\rtf1{\field{\*\fldinst INCLUDETEXT "https://example.test/a"}}}`,
    String.raw`{\rtf1{\field{\*\fldinst IMPORT "https://example.test/a"}}}`,
    String.raw`{\rtf1{\field{\*\fldinst LINK "https://example.test/a"}}}`,
    String.raw`{\rtf1{\field{\*\fldinst DDEAUTO "example"}}}`,
    String.raw`{\rtf1{\field{\*\fldinst SOMETHING "example"}}}`,
    String.raw`{\rtf1{\field{\*\fldinst \'4}}}`,
  ])("refuses undecodable or unlisted RTF fields", async (source) => {
    expect(
      await checkConversionInput("application/rtf", encode(source)),
    ).toEqual({
      kind: "refuse",
      reason: "external_reference",
      format: "application/rtf",
    });
  });

  test.each([
    String.raw`{\rtf1{\field{\*\fldinst PAGE}}}`,
    String.raw`{\rtf1{\field{\*\fldinst \'50AGE}}}`,
    String.raw`{\rtf1{\field{\*\fldinst HYPERLINK "https://example.test/terms"}}}`,
  ])("converts allowed RTF fields", async (source) => {
    expect(
      await checkConversionInput("application/rtf", encode(source)),
    ).toEqual({
      kind: "convert",
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

  test("scans long RTF escape runs within the time budget", async () => {
    const input = encode(
      `{\\fldinst HYPERLINK "local" ${"\\".repeat(1024 * 1024)}}`,
    );
    const startedAt = performance.now();
    const result = await checkConversionInput("application/rtf", input);
    const elapsed = performance.now() - startedAt;

    expect(result).toEqual({ kind: "convert" });
    expect(elapsed).toBeLessThan(200);
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
