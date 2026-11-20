import { describe, expect, test } from "bun:test";

import { ZipArchive } from "@stll/docx-core/zip";

import { readOfdDocument } from "@/api/lib/files/ofd-document";
import { openXmlDocumentPackage } from "@/api/lib/files/xml-document-package";

const OFD_NS = "http://www.ofdspec.org/2016";
const MAX_TEXT = 1000;

const ofdEntry = (...locations: string[]) =>
  `<OFD xmlns="${OFD_NS}" Version="1.0" DocType="OFD">${locations
    .map((location) => `<DocBody><DocRoot>${location}</DocRoot></DocBody>`)
    .join("")}</OFD>`;

const ofdDocument = (...locations: string[]) =>
  `<ofd:Document xmlns:ofd="${OFD_NS}"><ofd:Pages>${locations
    .map(
      (location, index) =>
        `<ofd:Page ID="${index + 1}" BaseLoc="${location}"/>`,
    )
    .join("")}</ofd:Pages></ofd:Document>`;

const ofdPage = (blocks: string) =>
  `<Page xmlns="${OFD_NS}"><Content><Layer>${blocks}</Layer></Content></Page>`;

const textBlock = (...runs: string[]) =>
  `<TextObject>${runs.map((run) => `<TextCode>${run}</TextCode>`).join("")}</TextObject>`;

const extract = async (bytes: Uint8Array, maxChars = MAX_TEXT) => {
  const reader = (await openXmlDocumentPackage(bytes)).unwrap();
  return readOfdDocument(reader, maxChars);
};

const zipEntries = async (entries: Record<string, string>) => {
  const archive = new ZipArchive();
  for (const [path, xml] of Object.entries(entries)) {
    archive.set(path, xml);
  }
  return await archive.generate({ compression: "store" });
};

describe("reading OFD page text", () => {
  test("reads the upstream OFDRW converter greeting fixture", async () => {
    const bytes = await Bun.file(
      new URL("fixtures/ofdrw/helloworld.ofd", import.meta.url),
    ).bytes();

    expect((await extract(bytes)).unwrap()).toEqual({
      text: "你好呀，OFD Reader&Writer！",
      truncated: false,
    });
  });

  test("follows declared body and page order and extracts only page object text", async () => {
    const bytes = await zipEntries({
      "unused/Content.xml": ofdPage(textBlock("Unreferenced content")),
      "另册/正文.xml": ofdDocument("/共享/尾页.xml"),
      "共享/尾页.xml": ofdPage(textBlock("最后一页")),
      "正文/第一/首页.xml": ofdPage(textBlock("下一页")),
      "正文/第二页.xml": ofdPage(
        `<PageBlock>${textBlock("前言\\0020&lt;司法&gt;", "<![CDATA[𠮷]]>")}</PageBlock>
        <TextObject xmlns="urn:example:extension"><TextCode>Foreign extension</TextCode></TextObject>
        <PathObject><TextObject><TextCode>Outside the page object hierarchy</TextCode></TextObject></PathObject>
        ${textBlock("第二个文字对象")}`,
      ),
      "正文/第一/文档.xml": ofdDocument("../第二页.xml", "./首页.xml"),
      "OFD.xml": ofdEntry("/正文/第一/文档.xml", "另册/正文.xml"),
    });

    expect((await extract(bytes)).unwrap()).toEqual({
      text: "前言 <司法>\n𠮷\n第二个文字对象\n\n下一页\n\n最后一页",
      truncated: false,
    });
  });

  test("reports a page with only image content as requiring OCR", async () => {
    const bytes = await zipEntries({
      "OFD.xml": ofdEntry("Document.xml"),
      "Document.xml": ofdDocument("Content.xml"),
      "Content.xml": ofdPage('<ImageObject ResourceID="3"/>'),
    });

    const result = await extract(bytes);
    expect(result.isErr() && result.error.message).toContain(
      "Image-only pages require OCR",
    );
  });

  test("reports a missing declared page instead of returning partial text", async () => {
    const bytes = await zipEntries({
      "OFD.xml": ofdEntry("Document.xml"),
      "Document.xml": ofdDocument("Content.xml", "Missing.xml"),
      "Content.xml": ofdPage(textBlock("First page text")),
    });

    expect((await extract(bytes)).isErr()).toBe(true);
  });

  test("truncates long page text without returning part of a character", async () => {
    const bytes = await zipEntries({
      "OFD.xml": ofdEntry("Document.xml"),
      "Document.xml": ofdDocument("Content.xml"),
      "Content.xml": ofdPage(textBlock("甲乙𠮷丙丁")),
    });

    expect((await extract(bytes, 3)).unwrap()).toEqual({
      text: "甲乙",
      truncated: true,
    });
  });
});
