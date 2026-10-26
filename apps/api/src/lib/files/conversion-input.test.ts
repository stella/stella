import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { writeZipEntry } from "@stll/docx-utils";

import {
  checkConversionInput,
  REFERENCE_ALLOWLIST,
} from "@/api/lib/files/conversion-input";
import type { ConvertibleMime } from "@/api/lib/files/pdf-derivative-policy";
import { legacyWordFile } from "@/api/tests/helpers/legacy-word-fixture";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const encodeUtf16 = (value: string, byteOrder: "le" | "be"): Uint8Array => {
  const bytes = new Uint8Array(2 + value.length * 2);
  bytes.set(byteOrder === "le" ? [0xff, 0xfe] : [0xfe, 0xff]);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < value.length; index++) {
    view.setUint16(
      2 + index * 2,
      value.codePointAt(index) ?? 0,
      byteOrder === "le",
    );
  }
  return bytes;
};
const encodeUtf16WithoutBom = (
  value: string,
  byteOrder: "le" | "be",
): Uint8Array => encodeUtf16(value, byteOrder).slice(2);
const zip = async (path: string, value: string): Promise<Uint8Array> =>
  new Uint8Array(
    await writeZipEntry(new JSZip(), path, encode(value)).generateAsync({
      type: "arraybuffer",
    }),
  );

const zipEntries = async (
  entries: Readonly<Record<string, string>>,
): Promise<Uint8Array> => {
  const archive = new JSZip();
  for (const [path, value] of Object.entries(entries)) {
    writeZipEntry(archive, path, encode(value));
  }
  return new Uint8Array(await archive.generateAsync({ type: "arraybuffer" }));
};

const zipBytes = async (path: string, value: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(
    await writeZipEntry(new JSZip(), path, value).generateAsync({
      type: "arraybuffer",
    }),
  );

const binaryField = (instruction: string): Uint8Array =>
  new Uint8Array([0x13, ...encode(instruction), 0x14]);

const fixtureMime = (path: string): ConvertibleMime | null => {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  switch (extension) {
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".odt":
      return "application/vnd.oasis.opendocument.text";
    case ".rtf":
      return "application/rtf";
    case ".doc":
      return "application/msword";
    default:
      return null;
  }
};

const DELIBERATE_FIXTURE_REFUSALS: Readonly<Record<string, string>> = {
  "apps/api/src/lib/docx/fixtures/spa-template-with-placeholders.docx":
    "contains unfinished template fields",
  "apps/api/src/lib/docx/fixtures/spa-template.docx":
    "contains unfinished template fields",
  "apps/api/src/lib/docx/fixtures/test-template.docx":
    "contains an external document resource",
};

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
  test.each(["le", "be"] as const)(
    "checks UTF-16%s HTML references",
    async (byteOrder) => {
      const remote = encodeUtf16(
        '<html><img src="https://example.test/a.png"></html>',
        byteOrder,
      );
      const local = encodeUtf16(
        '<html><img src="data:image/png;base64,AA=="></html>',
        byteOrder,
      );

      expect(await checkConversionInput("text/html", remote)).toMatchObject({
        kind: "refuse",
      });
      expect(await checkConversionInput("text/html", local)).toEqual({
        kind: "convert",
      });
    },
  );

  test("refuses a declared unsupported HTML encoding", async () => {
    expect(
      await checkConversionInput(
        "text/html",
        encode('<meta charset="windows-1252"><p>Document</p>'),
      ),
    ).toEqual({
      kind: "refuse",
      format: "text/html",
      reason: { kind: "unsupported_encoding", encoding: "windows-1252" },
    });
  });

  test.each([["utf", "8"].join(""), "unicode-1-1-utf-8"])(
    "accepts the standard UTF-8 label %s",
    async (encoding) => {
      expect(
        await checkConversionInput(
          "text/html",
          encode(`<meta charset="${encoding}"><p>Document</p>`),
        ),
      ).toEqual({ kind: "convert" });
    },
  );

  test("refuses a declaration that conflicts with the byte signature", async () => {
    const input = encodeUtf16WithoutBom(
      '<?xml version="1.0" encoding="UTF-8"?><document/>',
      "le",
    );

    expect(await checkConversionInput("application/xhtml+xml", input)).toEqual({
      kind: "refuse",
      format: "application/xhtml+xml",
      reason: { kind: "unsupported_encoding", encoding: "utf-8" },
    });
  });

  test.each(["application/xhtml+xml", "text/html"] as const)(
    "refuses a UTF-16 declaration in single-byte %s input",
    async (mime) => {
      const declaration =
        mime === "text/html"
          ? '<meta charset="UTF-16">'
          : '<?xml version="1.0" encoding="UTF-16"?>';
      const input = encode(
        `${declaration}<html><img src="https://example.test/a.png"/></html>`,
      );

      expect(await checkConversionInput(mime, input)).toEqual({
        kind: "refuse",
        format: mime,
        reason: { kind: "unsupported_encoding", encoding: "utf-16" },
      });
    },
  );

  test("checks a UTF-16 XML document part", async () => {
    const input = await zipBytes(
      "word/document.xml",
      encodeUtf16(
        '<?xml version="1.0" encoding="UTF-16"?><document image="https://example.test/a.png"/>',
        "le",
      ),
    );
    expect(
      await checkConversionInput(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        input,
      ),
    ).toMatchObject({ kind: "refuse" });
  });

  test.each([
    [
      "<iframe srcdoc=\"&lt;img src='https://example.test/a.png'&gt;\"></iframe>",
      "iframe",
      "srcdoc",
    ],
    ['<img src="data:text/html,%3Cp%3EDocument%3C/p%3E">', "img", "src"],
    ['<img src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E">', "img", "src"],
    [
      '<iframe src="da&#9;ta:text/html,%3Cimg src=https://example.test/a.png%3E"></iframe>',
      "iframe",
      "src",
    ],
    [
      '<iframe src="&#10;data:text/html,%3Cimg src=https://example.test/a.png%3E"></iframe>',
      "iframe",
      "src",
    ],
    [
      '<div style="background:url(data:image/svg+xml,%3Csvg%3E%3C/svg%3E)"></div>',
      "div",
      "style",
    ],
  ])("refuses a nested HTML reference", async (source, element, attribute) => {
    expect(
      await checkConversionInput("text/html", encode(source)),
    ).toMatchObject({
      kind: "refuse",
      reason: { kind: "unsupported_reference", element, attribute },
    });
  });

  test("converts an embedded raster image", async () => {
    expect(
      await checkConversionInput(
        "text/html",
        encode('<img src="data:image/png;base64,AA==">'),
      ),
    ).toEqual({ kind: "convert" });
  });

  test("every listed reference has a conversion case", async () => {
    const relationshipNamespaces = {
      transitional:
        "http://schemas.openxmlformats.org/package/2006/relationships",
      strict: "http://purl.oclc.org/ooxml/package/relationships",
    } as const;
    const officeRelationshipNamespaces = {
      transitional:
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
      strict: "http://purl.oclc.org/ooxml/officeDocument/relationships",
    } as const;
    const wordNamespaces = {
      transitional:
        "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
      strict: "http://purl.oclc.org/ooxml/wordprocessingml/main",
    } as const;
    const namespaceVariants = [
      {
        relationships: relationshipNamespaces.transitional,
        officeRelationships: officeRelationshipNamespaces.transitional,
        word: wordNamespaces.transitional,
      },
      {
        relationships: relationshipNamespaces.strict,
        officeRelationships: officeRelationshipNamespaces.strict,
        word: wordNamespaces.strict,
      },
    ] as const;
    const makeConversionCase = (
      name: string,
      mime: ConvertibleMime,
      bytes: () => Promise<Uint8Array> | Uint8Array,
    ): readonly [
      string,
      { mime: ConvertibleMime; bytes: () => Promise<Uint8Array> | Uint8Array },
    ] => [name, { mime, bytes }];
    const cases = new Map<
      string,
      { mime: ConvertibleMime; bytes: () => Promise<Uint8Array> | Uint8Array }
    >([
      [
        "xhtml|*|{http://www.w3.org/2000/xmlns/}*",
        {
          mime: "application/xhtml+xml",
          bytes: () =>
            encode('<root xmlns:item="https://example.test/schema"/>'),
        },
      ],
      [
        "ooxml|*|{http://www.w3.org/2000/xmlns/}*",
        {
          mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          bytes: async () =>
            zip(
              "word/document.xml",
              '<root xmlns:item="https://example.test/schema"/>',
            ),
        },
      ],
      [
        "odf|*|{http://www.w3.org/2000/xmlns/}*",
        {
          mime: "application/vnd.oasis.opendocument.text",
          bytes: async () =>
            zip(
              "content.xml",
              '<root xmlns:item="https://example.test/schema"/>',
            ),
        },
      ],
      [
        "html|*|xmlns",
        {
          mime: "text/html",
          bytes: () =>
            encode('<root xmlns="https://example.test/schema"></root>'),
        },
      ],
      [
        "html|*|xmlns:*",
        {
          mime: "text/html",
          bytes: () =>
            encode('<root xmlns:item="https://example.test/schema"></root>'),
        },
      ],
      [
        "html|a|href",
        {
          mime: "text/html",
          bytes: () => encode('<a href="https://example.test/page">page</a>'),
        },
      ],
      [
        "html|area|href",
        {
          mime: "text/html",
          bytes: () =>
            encode('<map><area href="https://example.test/page"></map>'),
        },
      ],
      [
        "xhtml|{http://www.w3.org/1999/xhtml}a|href",
        {
          mime: "application/xhtml+xml",
          bytes: () =>
            encode(
              '<h:a xmlns:h="http://www.w3.org/1999/xhtml" href="https://example.test/page"/>',
            ),
        },
      ],
      [
        "xhtml|{http://www.w3.org/1999/xhtml}area|href",
        {
          mime: "application/xhtml+xml",
          bytes: () =>
            encode(
              '<h:area xmlns:h="http://www.w3.org/1999/xhtml" href="https://example.test/page"/>',
            ),
        },
      ],
      [
        "xhtml|a|href",
        {
          mime: "application/xhtml+xml",
          bytes: () => encode('<a href="https://example.test/page"/>'),
        },
      ],
      [
        "xhtml|area|href",
        {
          mime: "application/xhtml+xml",
          bytes: () => encode('<area href="https://example.test/page"/>'),
        },
      ],
      ...namespaceVariants.flatMap(({ relationships, officeRelationships }) => [
        makeConversionCase(
          `ooxml|{${relationships}}Relationship|Target`,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          async () =>
            zip(
              "word/_rels/document.xml.rels",
              `<r:Relationship xmlns:r="${relationships}" Type="${officeRelationships}/hyperlink" Target="https://example.test/page"/>`,
            ),
        ),
        makeConversionCase(
          `ooxml|{${relationships}}Relationship|Type`,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          async () =>
            zip(
              "word/_rels/document.xml.rels",
              `<r:Relationship xmlns:r="${relationships}" Type="https://example.test/type"/>`,
            ),
        ),
      ]),
      [
        "ooxml|Relationship|Target",
        {
          mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          bytes: async () =>
            zip(
              "word/_rels/document.xml.rels",
              `<Relationship Type="${officeRelationshipNamespaces.transitional}/hyperlink" Target="https://example.test/page"/>`,
            ),
        },
      ],
      [
        "ooxml|Relationship|Type",
        {
          mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          bytes: async () =>
            zip(
              "word/_rels/document.xml.rels",
              '<Relationship Type="https://example.test/type"/>',
            ),
        },
      ],
      [
        "odf|{urn:oasis:names:tc:opendocument:xmlns:text:1.0}a|{http://www.w3.org/1999/xlink}href",
        {
          mime: "application/vnd.oasis.opendocument.text",
          bytes: async () =>
            zip(
              "content.xml",
              '<text:a xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://example.test/page"/>',
            ),
        },
      ],
      [
        "ooxml|*|uri",
        {
          mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          bytes: async () =>
            zip(
              "word/document.xml",
              '<a:ext xmlns:a="urn:example" uri="https://example.test/extension"/>',
            ),
        },
      ],
      ...namespaceVariants.map(({ word }) =>
        makeConversionCase(
          `ooxml|{${word}}compatSetting|{${word}}uri`,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          async () =>
            zip(
              "word/settings.xml",
              `<w:compatSetting xmlns:w="${word}" w:uri="https://example.test/schema"/>`,
            ),
        ),
      ),
      ...[
        "http://schemas.openxmlformats.org/officeDocument/2006/customXml",
        "http://purl.oclc.org/ooxml/officeDocument/customXml",
      ].map((namespace) =>
        makeConversionCase(
          `ooxml|{${namespace}}schemaRef|{${namespace}}uri`,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          async () =>
            zip(
              "customXml/itemProps.xml",
              `<c:schemaRef xmlns:c="${namespace}" c:uri="https://example.test/schema"/>`,
            ),
        ),
      ),
      makeConversionCase(
        "ooxml|{http://www.w3.org/2001/XMLSchema}schema|targetNamespace",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        async () =>
          zip(
            "customXml/item1.xml",
            '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="https://example.test/schema"/>',
          ),
      ),
      makeConversionCase(
        "ooxml|{http://www.w3.org/2001/XMLSchema}import|schemaLocation",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        async () =>
          zip(
            "customXml/item1.xml",
            '<xs:import xmlns:xs="http://www.w3.org/2001/XMLSchema" schemaLocation="https://example.test/schema.xsd"/>',
          ),
      ),
      makeConversionCase(
        "ooxml|{http://www.w3.org/2001/XMLSchema}import|namespace",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        async () =>
          zip(
            "customXml/item1.xml",
            '<xs:import xmlns:xs="http://www.w3.org/2001/XMLSchema" namespace="https://example.test/schema"/>',
          ),
      ),
      ...namespaceVariants.map(({ word }) =>
        makeConversionCase(
          `ooxml|{${word}}docVar|{${word}}val`,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          async () =>
            zip(
              "word/settings.xml",
              `<w:docVars xmlns:w="${word}"><w:docVar w:name="source" w:val="https://example.test/page"/></w:docVars>`,
            ),
        ),
      ),
      ...namespaceVariants.map(({ word, officeRelationships }) =>
        makeConversionCase(
          `ooxml|{${word}}hyperlink|{${officeRelationships}}id`,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          async () =>
            zip(
              "word/document.xml",
              `<w:hyperlink xmlns:w="${word}" xmlns:r="${officeRelationships}" r:id="https://example.test/page"/>`,
            ),
        ),
      ),
    ]);

    expect(cases.size).toBe(REFERENCE_ALLOWLIST.length);
    for (const entry of REFERENCE_ALLOWLIST) {
      const name = `${entry.format}|${entry.element}|${entry.attribute}`;
      const conversionCase = cases.get(name);
      expect(conversionCase, name).toBeDefined();
      if (conversionCase === undefined) {
        continue;
      }
      const bytes = await conversionCase.bytes();
      expect(
        await checkConversionInput(conversionCase.mime, bytes),
        name,
      ).toEqual({
        kind: "convert",
      });
      const withoutEntry = REFERENCE_ALLOWLIST.filter(
        (candidate) => candidate !== entry,
      );
      const expectedElement = entry.element === "*" ? "root" : entry.element;
      const expectedAttribute = entry.attribute.endsWith("*")
        ? `${entry.attribute.slice(0, -1)}item`
        : entry.attribute;
      expect(
        await checkConversionInput(conversionCase.mime, bytes, withoutEntry),
        name,
      ).toMatchObject({
        kind: "refuse",
        reason: {
          kind: "unsupported_reference",
          element:
            entry.element === "*" && entry.attribute === "uri"
              ? "{urn:example}ext"
              : expectedElement,
          attribute: expectedAttribute,
        },
      });
    }
  });

  test("converts realistic documents", async () => {
    const ooxmlDocument = async ({
      name,
      mime,
      directory,
      main,
    }: {
      name: string;
      mime: ConvertibleMime;
      directory: string;
      main: string;
    }): Promise<readonly [string, ConvertibleMime, Uint8Array]> => [
      name,
      mime,
      await zipEntries({
        [`${directory}/${main}`]:
          '<a:document xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="a"><a:extLst><a:ext uri="{55555555-5555-5555-5555-555555555555}"/></a:extLst></a:document>',
        [`${directory}/_rels/${main}.rels`]:
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="link" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.test/page" TargetMode="External"/></Relationships>',
        [`${directory}/theme/theme1.xml`]:
          '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Theme"/>',
        [`${directory}/styles.xml`]:
          '<a:styleSheet xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>',
        "docProps/core.xml":
          '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><cp:category>case</cp:category><dcterms:created xsi:type="dcterms:W3CDTF">2026-10-20T00:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-10-20T00:00:00Z</dcterms:modified></cp:coreProperties>',
        "docProps/app.xml":
          '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>stella</Application></Properties>',
        "docProps/custom.xml":
          '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"><property name="kind">document</property></Properties>',
      }),
    ];
    const documents = [
      [
        "DOCX",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        await zipEntries({
          "word/document.xml":
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" mc:Ignorable="a"><w:body><w:hyperlink r:id="link"><w:r><w:t>Page</w:t></w:r></w:hyperlink><w:fldSimple w:instr=\'TIME \\@ "HH:mm"\'><w:r><w:t>12:00</w:t></w:r></w:fldSimple><a:extLst><a:ext uri="{11111111-1111-1111-1111-111111111111}"/></a:extLst></w:body></w:document>',
          "word/_rels/document.xml.rels":
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="link" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.test/page" TargetMode="External"/></Relationships>',
          "word/theme/theme1.xml":
            '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Theme"><a:extLst><a:ext uri="{22222222-2222-2222-2222-222222222222}"/></a:extLst></a:theme>',
          "word/styles.xml":
            '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Normal"/></w:styles>',
          "docProps/core.xml":
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><cp:category>case</cp:category><dcterms:created xsi:type="dcterms:W3CDTF">2026-10-20T00:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-10-20T00:00:00Z</dcterms:modified></cp:coreProperties>',
          "docProps/app.xml":
            '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>stella</Application></Properties>',
          "docProps/custom.xml":
            '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"><property name="kind">document</property></Properties>',
        }),
      ],
      [
        "Strict DOCX",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        await zipEntries({
          "word/document.xml":
            '<w:document xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main" xmlns:r="http://purl.oclc.org/ooxml/officeDocument/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:a="http://purl.oclc.org/ooxml/drawingml/main" mc:Ignorable="a"><w:body><w:hyperlink r:id="link"><w:r><w:t>Page</w:t></w:r></w:hyperlink><a:extLst><a:ext uri="{33333333-3333-3333-3333-333333333333}"/></a:extLst></w:body></w:document>',
          "word/_rels/document.xml.rels":
            '<Relationships xmlns="http://purl.oclc.org/ooxml/package/relationships"><Relationship Id="link" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/hyperlink" Target="https://example.test/page" TargetMode="External"/></Relationships>',
          "word/theme/theme1.xml":
            '<a:theme xmlns:a="http://purl.oclc.org/ooxml/drawingml/main" name="Theme"><a:extLst><a:ext uri="{44444444-4444-4444-4444-444444444444}"/></a:extLst></a:theme>',
          "word/styles.xml":
            '<w:styles xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main"><w:style w:type="paragraph" w:styleId="Normal"/></w:styles>',
          "docProps/core.xml":
            '<cp:coreProperties xmlns:cp="http://purl.oclc.org/ooxml/package/metadata/core-properties"><cp:category>case</cp:category></cp:coreProperties>',
          "docProps/app.xml":
            '<Properties xmlns="http://purl.oclc.org/ooxml/officeDocument/extendedProperties"><Application>stella</Application></Properties>',
          "docProps/custom.xml":
            '<Properties xmlns="http://purl.oclc.org/ooxml/officeDocument/customProperties"><property name="kind">document</property></Properties>',
        }),
      ],
      await ooxmlDocument({
        name: "XLSX",
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        directory: "xl",
        main: "workbook.xml",
      }),
      await ooxmlDocument({
        name: "PPTX",
        mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        directory: "ppt",
        main: "presentation.xml",
      }),
      [
        "ODT",
        "application/vnd.oasis.opendocument.text",
        await zipEntries({
          "content.xml":
            '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:a="urn:example:extensions" mc:Ignorable="a"><office:body><text:a xlink:href="https://example.test/page">Page</text:a><a:extLst><a:ext uri="{66666666-6666-6666-6666-666666666666}"/></a:extLst></office:body></office:document-content>',
          "styles.xml":
            '<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:styles/></office:document-styles>',
          "META-INF/theme.xml":
            '<office:theme xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>',
          "meta.xml":
            '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:meta><office:core>core</office:core><office:app>stella</office:app><office:custom>document</office:custom></office:meta></office:document-meta>',
        }),
      ],
      [
        "HTML",
        "text/html",
        encode(
          '<!doctype html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:a="urn:example:extensions" mc:Ignorable="a"><head><style>body { color: black; }</style><meta name="core" content="case"><meta name="app" content="stella"><meta name="custom" content="document"><a:theme><a:extLst><a:ext uri="{77777777-7777-7777-7777-777777777777}"></a:ext></a:extLst></a:theme></head><body><a href="https://example.test/page">Page</a></body></html>',
        ),
      ],
      [
        "RTF",
        "application/rtf",
        encode('{\\rtf1{\\field{\\*\\fldinst TIME \\@ "HH:mm"}}}'),
      ],
    ] satisfies readonly (readonly [string, ConvertibleMime, Uint8Array])[];
    for (const [name, mime, bytes] of documents) {
      expect(await checkConversionInput(mime, bytes), name).toEqual({
        kind: "convert",
      });
    }
  });

  test("converts the repository document corpus", async () => {
    const root = new URL("../../../../../", import.meta.url).pathname;
    const paths: string[] = [];
    for (const directory of ["apps", "packages"]) {
      const glob = new Bun.Glob(`**/*.{docx,xlsx,pptx,odt,rtf,doc}`);
      for await (const path of glob.scan({
        cwd: `${root}${directory}`,
        onlyFiles: true,
      })) {
        paths.push(`${directory}/${path}`);
      }
    }
    paths.sort();
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      const mime = fixtureMime(path);
      expect(mime, path).not.toBeNull();
      if (mime === null) {
        continue;
      }
      const result = await checkConversionInput(
        mime,
        new Uint8Array(await Bun.file(`${root}${path}`).arrayBuffer()),
      );
      const refusalReason = DELIBERATE_FIXTURE_REFUSALS[path];
      if (refusalReason !== undefined) {
        expect(refusalReason.length, path).toBeGreaterThan(0);
        expect(result.kind, path).toBe("refuse");
        continue;
      }
      expect(result, path).toEqual({ kind: "convert" });
    }
  });

  test("converts field formatting switches", async () => {
    const input = await zip(
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:fldSimple w:instr=\'TIME \\@ "file:HH:mm"\'/></w:document>',
    );
    expect(
      await checkConversionInput(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        input,
      ),
    ).toEqual({ kind: "convert" });
  });

  test("refuses an unrecognized OOXML reference attribute", async () => {
    const input = await zip(
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:unknown r:link="https://x.test/a.png"/></w:document>',
    );
    expect(
      await checkConversionInput(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        input,
      ),
    ).toEqual({
      kind: "refuse",
      format:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      reason: {
        kind: "unsupported_reference",
        format:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        element:
          "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}unknown",
        attribute:
          "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}link",
      },
    });
  });

  test.each([
    ['<x-thing src="//x.test/a"></x-thing>', "x-thing", "src"],
    [
      '<section data-note="background:url(https://x.test/a)"></section>',
      "section",
      "data-note",
    ],
  ])(
    "refuses an unrecognized HTML reference",
    async (source, element, attribute) => {
      expect(await checkConversionInput("text/html", encode(source))).toEqual({
        kind: "refuse",
        format: "text/html",
        reason: {
          kind: "unsupported_reference",
          format: "text/html",
          element,
          attribute,
        },
      });
    },
  );

  test("refuses an unrecognized ODF reference attribute", async () => {
    const input = await zip(
      "content.xml",
      '<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:unknown="https://x.test/a"/>',
    );
    expect(
      await checkConversionInput(
        "application/vnd.oasis.opendocument.text",
        input,
      ),
    ).toMatchObject({
      kind: "refuse",
      reason: {
        kind: "unsupported_reference",
        attribute: "{urn:oasis:names:tc:opendocument:xmlns:office:1.0}unknown",
      },
    });
  });

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

  test("legacy Word refuses a non-navigation field reference", async () => {
    expect(
      await checkConversionInput(
        "application/msword",
        legacyWordFile(["\u0013QUOTE https://x.test/value\u0015"]),
      ),
    ).toMatchObject({ kind: "refuse" });
  });

  test("RTF refuses a non-navigation field reference", async () => {
    expect(
      await checkConversionInput(
        "application/rtf",
        encode('{\\rtf1{\\field{\\*\\fldinst QUOTE "https://x.test/value"}}}'),
      ),
    ).toMatchObject({ kind: "refuse" });
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
    const result = await checkConversionInput("text/html", encode(source));
    expect(result.kind).toBe("refuse");
  });

  test.each([
    [
      "application/xhtml+xml",
      '<html xmlns="http://www.w3.org/1999/xhtml"><svg xmlns="http://www.w3.org/2000/svg"><style><![CDATA[@import url(https://example.test/a.css);]]></style></svg></html>',
    ],
    [
      "application/xhtml+xml",
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://example.test/a.css);</style></svg>',
    ],
    [
      "text/html",
      "<svg><style>@import url(https://example.test/a.css);</style></svg>",
    ],
  ] satisfies readonly [ConvertibleMime, string][])(
    "refuses style references in every element namespace",
    async (mime, source) => {
      expect(await checkConversionInput(mime, encode(source))).toMatchObject({
        kind: "refuse",
      });
    },
  );

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

  test("refuses an unfinished OOXML field instruction", async () => {
    const input = await zip(
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:fldChar w:fldCharType="begin"/><w:instrText>INCLUDEPICTURE https://example.test/a.png</w:instrText></w:document>',
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
    '{\\rtf1{\\field{\n\\*\\fldinst INCLUDEPICTURE "https://example.test/a.png"}}}',
    '{\\rtf1{\\field{\\*\n\\fldinst INCLUDEPICTURE "https://example.test/a.png"}}}',
    '{\\rtf1{\\field{\r\n\\*\r\n\\fldinst INCLUDEPICTURE "https://example.test/a.png"}}}',
    '{\\rtf1{\\field{\n\\*\n\\fldinst\nINCLUDEPICTURE "https://example.test/a.png"}}}',
  ])("refuses line-separated RTF field destinations", async (source) => {
    expect(
      await checkConversionInput("application/rtf", encode(source)),
    ).toEqual({
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
