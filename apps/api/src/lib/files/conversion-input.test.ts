import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { writeZipEntry } from "@stll/docx-utils";

import { checkConversionInput } from "@/api/lib/files/conversion-input";
import type { ConvertibleMime } from "@/api/lib/files/pdf-derivative-policy";
import { legacyWordFile } from "@/api/tests/helpers/legacy-word-fixture";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const zip = async (path: string, value: string): Promise<Uint8Array> =>
  new Uint8Array(
    await writeZipEntry(new JSZip(), path, encode(value)).generateAsync({
      type: "arraybuffer",
    }),
  );

const binaryField = (instruction: string): Uint8Array =>
  new Uint8Array([0x13, ...encode(instruction), 0x14]);

type Fixture = {
  mime: ConvertibleMime;
  remote: Uint8Array;
  local: Uint8Array;
  remoteReason?: "external_reference" | "unsupported_field";
};

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
      '<content xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"><draw:image xlink:href="https://example.test/image.png"/></content>',
    ),
    local: await zip(
      "content.xml",
      '<content xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"><text:a xlink:href="https://example.test/terms">Terms</text:a><draw:image xlink:href="Pictures/a.png"/></content>',
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
    remote: legacyWordFile(["\u0013INCLUDETEXT file.doc\u0015"]),
    local: legacyWordFile(["\u0013HYPERLINK https://example.test/terms\u0015"]),
    remoteReason: "unsupported_field",
  },
} as const satisfies Record<string, Fixture>;

describe("document conversion input", () => {
  test("legacy Word reads compressed and wide text pieces", async () => {
    const first = "\u0013PAGE\u0015";
    const second = "\u0013HYPERLINK https://example.test\u0015";
    expect(
      await checkConversionInput(
        "application/msword",
        legacyWordFile(
          [first + second],
          [{ text: first }, { text: second, wide: true }],
        ),
      ),
    ).toEqual({ kind: "convert" });
  });

  test.each(["INCLUDEPICTURE", "INCLUDETEXT"])(
    "legacy Word refuses a %s field by name",
    async (fieldType) => {
      expect(
        await checkConversionInput(
          "application/msword",
          legacyWordFile([`\u0013${fieldType} file\u0014result\u0015`]),
        ),
      ).toEqual({
        kind: "refuse",
        format: "application/msword",
        reason: { kind: "unsupported_field", fieldType },
      });
    },
  );

  test("legacy Word checks nested field instructions", async () => {
    expect(
      await checkConversionInput(
        "application/msword",
        legacyWordFile(["\u0013IF \u0013INCLUDEPICTURE file\u0015 = x\u0015"]),
      ),
    ).toMatchObject({
      kind: "refuse",
      reason: { kind: "unsupported_field", fieldType: "INCLUDEPICTURE" },
    });
  });

  test("legacy Word checks footnote text independently", async () => {
    expect(
      await checkConversionInput(
        "application/msword",
        legacyWordFile(["main", "\u0013INCLUDETEXT file\u0015"]),
      ),
    ).toMatchObject({
      kind: "refuse",
      reason: { kind: "unsupported_field", fieldType: "INCLUDETEXT" },
    });
  });

  test("legacy Word ignores field bytes outside document text", async () => {
    expect(
      await checkConversionInput(
        "application/msword",
        legacyWordFile(["ordinary text"], undefined, [
          { path: ["Data"], bytes: binaryField("INCLUDETEXT file") },
        ]),
      ),
    ).toEqual({ kind: "convert" });
  });

  test("legacy Word refuses a truncated piece table", async () => {
    const input = legacyWordFile(["text"]);
    const truncated = input.slice(0, input.byteLength - 64);
    expect(await checkConversionInput("application/msword", truncated)).toEqual(
      {
        kind: "refuse",
        format: "application/msword",
        reason: { kind: "inspection_failed" },
      },
    );
  });

  test("keeps qualified XML names centralized", async () => {
    const source = await Bun.file(
      new URL("conversion-input.ts", import.meta.url),
    ).text();
    const withoutNamespaceMap = source.replace(
      /const XML_NAMESPACES = \{[\s\S]*?\} as const;/u,
      "",
    );

    expect(withoutNamespaceMap).not.toMatch(
      /["'`](?:xlink|w|r|draw|text|office|svg):|["'`]<[a-z][\w.-]*:[\w.-]+/iu,
    );

    const namespaceMap =
      /const XML_NAMESPACES = \{([\s\S]*?)\} as const;/u.exec(source)?.[1];
    expect(namespaceMap).toBeDefined();
    const ooxmlNamespaces = [
      ...(namespaceMap?.matchAll(
        /https?:\/\/(?:schemas\.openxmlformats\.org|purl\.oclc\.org\/ooxml)\/[^"\s]+/gu,
      ) ?? []),
    ].map(([namespace]) => namespace);
    expect(ooxmlNamespaces).toEqual([
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
      "http://purl.oclc.org/ooxml/officeDocument/relationships",
      "http://schemas.openxmlformats.org/package/2006/relationships",
      "http://purl.oclc.org/ooxml/package/relationships",
      "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
      "http://purl.oclc.org/ooxml/wordprocessingml/main",
    ]);
  });

  test.each(Object.entries(fixtures))(
    "%s refuses remote resources",
    async (_name, fixture) => {
      const result = await checkConversionInput(fixture.mime, fixture.remote);
      expect(result.kind).toBe("refuse");
      if (result.kind === "refuse") {
        expect(result.reason.kind).toBe(
          "remoteReason" in fixture
            ? fixture.remoteReason
            : "external_reference",
        );
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
      reason: { kind: "external_reference" },
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
      reason: { kind: "external_reference" },
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

  test.each(["image", "use", "feImage"])(
    "refuses an HTML foreign %s reference",
    async (element) => {
      const source = `<svg><${element} xlink:href="https://example.test/a.png"></${element}></svg>`;
      expect(await checkConversionInput("text/html", encode(source))).toEqual({
        kind: "refuse",
        reason: { kind: "external_reference" },
        format: "text/html",
      });
    },
  );

  test("allows an HTML foreign navigation reference", async () => {
    const source = '<svg><a xlink:href="https://x.test">link</a></svg>';
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
      reason: { kind: "external_reference" },
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
      reason: { kind: "external_reference" },
      format:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  });

  test.each([
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
    "http://purl.oclc.org/ooxml/officeDocument/relationships/hyperlink",
  ])("allows an external OOXML hyperlink relationship", async (type) => {
    const input = await zip(
      "word/_rels/document.xml.rels",
      `<Relationships><Relationship Type=" ${type} " Target="https://example.test/page" TargetMode="External"/></Relationships>`,
    );
    expect(
      await checkConversionInput(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        input,
      ),
    ).toEqual({ kind: "convert" });
  });

  test.each([
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
    "urn:x/hyperlink",
  ])("refuses a non-hyperlink OOXML relationship", async (type) => {
    const input = await zip(
      "word/_rels/document.xml.rels",
      `<Relationships><Relationship Type="${type}" Target="https://example.test/page" TargetMode="External"/></Relationships>`,
    );
    expect(
      await checkConversionInput(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        input,
      ),
    ).toEqual({
      kind: "refuse",
      reason: { kind: "external_reference" },
      format:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  });

  test.each([
    "word/footnotes.xml",
    "word/endnotes.xml",
    "word/comments.xml",
    "word/glossary/document.xml",
  ])("refuses an unsupported field in %s", async (path) => {
    const input = await zip(
      path,
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:fldSimple w:instr="INCLUDEPICTURE https://example.test/a.png"/></w:document>',
    );
    expect(
      await checkConversionInput(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        input,
      ),
    ).toEqual({
      kind: "refuse",
      reason: { kind: "unsupported_field", fieldType: "INCLUDEPICTURE" },
      format:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  });

  test.each([
    ["application/vnd.ms-excel", ".xlsx"],
    ["application/vnd.ms-powerpoint", ".pptx"],
  ] as const)(
    "refuses %s with its replacement format",
    async (mime, extension) => {
      expect(await checkConversionInput(mime, new Uint8Array())).toEqual({
        kind: "refuse",
        reason: { kind: "legacy_format", replacementExtension: extension },
        format: mime,
      });
    },
  );

  test("refuses OOXML relationships by namespace", async () => {
    const input = await zip(
      "word/_rels/document.xml.rels",
      '<p:Relationships xmlns:p="http://schemas.openxmlformats.org/package/2006/relationships"><p:Relationship Target="https://example.test/a"/></p:Relationships>',
    );
    expect(
      await checkConversionInput(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        input,
      ),
    ).toEqual({
      kind: "refuse",
      reason: { kind: "external_reference" },
      format:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  });

  test.each([
    '<root xmlns:d="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:r="http://www.w3.org/1999/xlink"><d:image r:href="https://example.test/a.png"/></root>',
    '<root xmlns:d="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:r="http://www.w3.org/1999/xlink"><d:object r:href="https://example.test/a"/></root>',
    '<root xmlns:d="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"><d:image xlink:href="https://example.test/a.png"/></root>',
  ])("refuses ODF references by namespace", async (document) => {
    const input = await zip("content.xml", document);
    expect(
      await checkConversionInput(
        "application/vnd.oasis.opendocument.text",
        input,
      ),
    ).toEqual({
      kind: "refuse",
      reason: { kind: "external_reference" },
      format: "application/vnd.oasis.opendocument.text",
    });
  });

  test("converts a local ODF reference by namespace", async () => {
    const input = await zip(
      "content.xml",
      '<root xmlns:d="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:r="http://www.w3.org/1999/xlink"><d:image r:href="Pictures/a.png"/></root>',
    );
    expect(
      await checkConversionInput(
        "application/vnd.oasis.opendocument.text",
        input,
      ),
    ).toEqual({ kind: "convert" });
  });

  test.each(["use", "image"])(
    "refuses SVG %s references by namespace",
    async (element) => {
      const input = encode(
        `<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns:s="http://www.w3.org/2000/svg" xmlns:r="http://www.w3.org/1999/xlink"><s:svg><s:${element} r:href="https://example.test/a.png"/></s:svg></h:html>`,
      );
      expect(
        await checkConversionInput("application/xhtml+xml", input),
      ).toEqual({
        kind: "refuse",
        reason: { kind: "external_reference" },
        format: "application/xhtml+xml",
      });
    },
  );

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
      reason: { kind: "unsupported_field", fieldType: "INCLUDEPICTURE" },
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
      reason: { kind: "unsupported_field", fieldType: "INCLUDEPICTURE" },
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

  test.each([
    [
      "simple",
      '<w:document xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main"><w:fldSimple w:instr="INCLUDEPICTURE https://example.test/a.png"/></w:document>',
      "INCLUDEPICTURE",
    ],
    [
      "complex",
      '<w:document xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main"><w:fldChar w:fldCharType="begin"/><w:instrText>INCLUDETEXT https://example.test/a.docx</w:instrText><w:fldChar w:fldCharType="end"/></w:document>',
      "INCLUDETEXT",
    ],
  ])("refuses a Strict %s field", async (_kind, document, fieldType) => {
    const input = await zip("word/document.xml", document);
    expect(
      await checkConversionInput(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        input,
      ),
    ).toEqual({
      kind: "refuse",
      reason: { kind: "unsupported_field", fieldType },
      format:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  });

  test("converts an allowed Strict field", async () => {
    const input = await zip(
      "word/document.xml",
      '<w:document xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main"><w:fldSimple w:instr="PAGE"/></w:document>',
    );
    expect(
      await checkConversionInput(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        input,
      ),
    ).toEqual({ kind: "convert" });
  });

  test.each([
    [
      "image",
      "http://purl.oclc.org/ooxml/officeDocument/relationships/image",
      "refuse",
    ],
    [
      "hyperlink",
      "http://purl.oclc.org/ooxml/officeDocument/relationships/hyperlink",
      "convert",
    ],
  ] as const)(
    "handles a Strict %s external relationship",
    async (_kind, type, outcome) => {
      const input = await zip(
        "word/_rels/document.xml.rels",
        `<Relationships xmlns="http://purl.oclc.org/ooxml/package/relationships"><Relationship Type="${type}" Target="https://example.test/resource" TargetMode="External"/></Relationships>`,
      );
      const result = await checkConversionInput(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        input,
      );
      expect(result.kind).toBe(outcome);
    },
  );

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
      reason: { kind: "unsupported_field", fieldType: "INCLUDEPICTURE" },
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
      reason: { kind: "unsupported_field", fieldType: "INCLUDEPICTURE" },
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
      reason: { kind: "external_reference" },
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
      reason: { kind: "external_reference" },
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

  test.each([
    String.raw`{\rtf1{\field{\*\fldinst IF 1 = 1 "yes" "no" {\field{\*\fldinst INCLUDEPICTURE "https://example.test/a.png"}}}}}`,
    String.raw`{\rtf1{\field{\*\fldinst IF 1 = 1 "yes" "no"}{\fldrslt {\field{\*\fldinst INCLUDEPICTURE "https://example.test/a.png"}}}}}`,
    String.raw`{\rtf1{\field{\*\fldinst IF 1 = 1 "yes" "no" {\field{\*\fldinst IF 1 = 1 "yes" "no" {\field{\*\fldinst INCLUDEPICTURE "https://example.test/a.png"}}}}}}}`,
  ])("refuses nested unlisted RTF fields", async (source) => {
    expect(
      await checkConversionInput("application/rtf", encode(source)),
    ).toEqual({
      kind: "refuse",
      reason: { kind: "external_reference" },
      format: "application/rtf",
    });
  });

  test.each([
    String.raw`{\rtf1{\field{\*\fldinst IF 1 = 1 "yes" "no" {\field{\*\fldinst PAGE}}}}}`,
    String.raw`{\rtf1{\field{\*\fldinst IF 1 = 1 "yes" "no"}{\fldrslt {\field{\*\fldinst HYPERLINK "https://example.test/terms"}}}}}`,
  ])("converts nested listed RTF fields", async (source) => {
    expect(
      await checkConversionInput("application/rtf", encode(source)),
    ).toEqual({ kind: "convert" });
  });

  test.each([
    String.raw`{\rtf1{\field{\*\fldinst PAGE}`,
    String.raw`{\rtf1{\field{\*\fldinst IF 1 = 1 "yes" "no" {\field{\*\fldinst PAGE}}}`,
  ])("refuses unfinished RTF field groups", async (source) => {
    expect(
      await checkConversionInput("application/rtf", encode(source)),
    ).toEqual({
      kind: "refuse",
      reason: { kind: "external_reference" },
      format: "application/rtf",
    });
  });

  test("counts RTF braces after escaped backslashes", async () => {
    const input = encode(
      '{\\field{\\fldinst HYPERLINK "local" \\\\{ INCLUDEPICTURE "http://x.invalid/a.png"}}{\\fldinst INCLUDETEXT "http://x.invalid/body"}}',
    );
    expect(await checkConversionInput("application/rtf", input)).toEqual({
      kind: "refuse",
      reason: { kind: "external_reference" },
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
