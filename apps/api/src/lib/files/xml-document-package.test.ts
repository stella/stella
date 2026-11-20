import { expect, test } from "bun:test";

import { ZipArchive } from "@stll/docx-core/zip";

import { openXmlDocumentPackage } from "@/api/lib/files/xml-document-package";

const xmlPart = async (part: Uint8Array | string) => {
  const zip = new ZipArchive();
  zip.set("content.xml", part);
  const archive = await openXmlDocumentPackage(await zip.generate());
  return archive.unwrap()("content.xml");
};

test.each([
  { encoding: "GB18030", bytes: [0xc4, 0xe3, 0xba, 0xc3], text: "你好" },
  { encoding: "windows-1254", bytes: [0xdd, 0xfd, 0xde], text: "İıŞ" },
])(
  "decodes explicitly declared $encoding text in a document part",
  async ({ encoding, bytes, text }) => {
    const part = Buffer.concat([
      Buffer.from(`<?xml version="1.0" encoding="${encoding}"?><text>`),
      Buffer.from(bytes),
      Buffer.from("</text>"),
    ]);
    expect((await xmlPart(part)).unwrap().text).toBe(text);
  },
);

test.each([
  "<!DOCTYPE text><text/>",
  "<text><x></text>",
  "<n>".repeat(100) + "</n>".repeat(100),
])("refuses an unsupported XML part", async (xml) => {
  expect((await xmlPart(xml)).isErr()).toBe(true);
});

test("refuses a document type with an internal entity before expanding it", async () => {
  const read = await xmlPart('<!DOCTYPE t [<!ENTITY x "y">]><t>&x;</t>');
  expect(read.isErr() && read.error.reason).toBe("invalid");
});

test("reads a character that straddles a parser write boundary", async () => {
  const opening = "<text>";
  const filler = "a".repeat(64 * 1024 - opening.length - 1);
  const read = await xmlPart(`${opening}${filler}😀</text>`);
  expect(read.unwrap().text).toBe(`${filler}😀`);
});

test("takes the legacy encoding only from the XML declaration", async () => {
  const part = Buffer.concat([
    Buffer.from('<?xml version="1.0"?><text encoding="windows-1254">'),
    Buffer.from([0xdd]),
    Buffer.from("</text>"),
  ]);
  const read = await xmlPart(part);
  expect(read.isErr() && read.error.reason).toBe("invalid");
});

test("reports the node budget as a reading limit", async () => {
  const read = await xmlPart(`<r>${"<a/>".repeat(150_001)}</r>`);
  expect(read.isErr() && read.error.reason).toBe("limit");
});
