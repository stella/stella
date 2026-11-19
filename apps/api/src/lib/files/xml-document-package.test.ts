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
