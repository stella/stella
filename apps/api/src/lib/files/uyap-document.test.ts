import { describe, expect, test } from "bun:test";

import { ZipArchive } from "@stll/docx-core/zip";

import { readUyapDocument } from "@/api/lib/files/uyap-document";
import { openXmlDocumentPackage } from "@/api/lib/files/xml-document-package";

const contentXml = (pool: string, layout: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><template format_id="1.8">
  <content><![CDATA[${pool}]]></content>
  <properties><pageFormat mediaSizeName="1"/></properties>
  <elements resolver="hvl-default">${layout}</elements>
  <styles><style name="hvl-default" family="Times New Roman" /></styles>
  <webID>000000</webID>
</template>`;

const readUdf = async (xml: string, maxChars = 1024, path = "content.xml") => {
  const archive = new ZipArchive();
  const encoder = new TextEncoder();
  archive.set(path, encoder.encode(xml));
  archive.set("documentproperties.xml", encoder.encode("<properties/>"));
  const bytes = await archive.generate({ compression: "deflate" });
  const reader = (await openXmlDocumentPackage(bytes)).unwrap();
  return readUyapDocument(reader, maxChars);
};

describe("UYAP document text", () => {
  test("reads a UDF 1.8 layout in display order", async () => {
    // Synthetic text, with the structure of the public udfpdf integration fixture:
    // https://github.com/gokselb/udfpdf/tree/b37575df55ac0ea84251b113cc7b87d4313c747c/tests/fixtures
    const pool =
      "Başlık\nKonu: İçtihat📄\tsatır\nHücre A\nHücre B\nSon\n\u200b\nDipnot\n\ufffcyedek";
    const layout = `
      <header><paragraph><content startOffset="0" length="7"/></paragraph></header>
      <paragraph>
        <content startOffset="7" length="5"/>
        <space startOffset="12" length="1"/>
        <field fieldName="subject" startOffset="13" length="9"/>
        <tab startOffset="22" length="1"/>
        <content startOffset="23" length="6"/>
      </paragraph>
      <table columnCount="2"><row>
        <cell><paragraph><content startOffset="29" length="8"/></paragraph></cell>
        <cell><paragraph><content startOffset="37" length="8"/></paragraph></cell>
      </row></table>
      <paragraph><content startOffset="49" length="2"/></paragraph>
      <paragraph>
        <image startOffset="58" length="1"/>
        <content startOffset="45" length="4"/>
      </paragraph>
      <footer><paragraph><content startOffset="51" length="7"/></paragraph></footer>
    `;
    expect((await readUdf(contentXml(pool, layout))).unwrap()).toEqual({
      text: "Başlık\nKonu: İçtihat📄\tsatır\nHücre A\tHücre B\n\nSon\nDipnot",
      truncated: false,
    });
  });

  test("reads the legacy UYAP 1.7 paragraph layout", async () => {
    // The legacy Editor stored text and layout separately just as UDF 1.8 does.
    // https://forum.donanimhaber.com/uyap-a-uyumlu-udf-ya-da-xml-formatli-dosyalar-olusturmak--76852703
    const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<template format_id="1.7">
  <content><![CDATA[Örnek
Yazı]]></content>
  <properties><pageFormat mediaSizeName="1"/></properties>
  <styles><style name="hvl-default" size="12"/></styles>
  <elements>
    <paragraph resolver="hvl-default"><content startOffset="0" length="6"/></paragraph>
    <paragraph resolver="hvl-default"><content startOffset="6" length="4"/></paragraph>
  </elements>
</template>`;
    expect((await readUdf(xml)).unwrap().text).toBe("Örnek\nYazı");
  });

  test("preserves breaks within a paragraph and omits the stored paragraph terminator", async () => {
    const xml = contentXml(
      "A\nB\nC",
      '<paragraph><content startOffset="0" length="4"/></paragraph><paragraph><content startOffset="4" length="1"/></paragraph>',
    );
    expect((await readUdf(xml)).unwrap().text).toBe("A\nB\nC");
  });

  test("requires both endpoints to be UTF-16 character boundaries", async () => {
    const pool = "A📄B";
    for (const run of [
      '<content startOffset="0" length="2"/>',
      '<content startOffset="2" length="2"/>',
    ]) {
      expect(
        (
          await readUdf(contentXml(pool, `<paragraph>${run}</paragraph>`))
        ).isErr(),
      ).toBe(true);
    }
  });

  test("truncates only at a complete UTF-16 character", async () => {
    const xml = contentXml(
      "A📄B",
      '<paragraph><content startOffset="0" length="4"/></paragraph>',
    );
    expect((await readUdf(xml, 2)).unwrap()).toEqual({
      text: "A",
      truncated: true,
    });
  });

  test("excludes leading whitespace from the visible text budget", async () => {
    const xml = contentXml(
      "         Türkçe",
      '<paragraph><content startOffset="0" length="15"/></paragraph>',
    );
    expect((await readUdf(xml, 4)).unwrap()).toEqual({
      text: "Türk",
      truncated: true,
    });
  });

  test("caps repeated range output and still validates all later references", async () => {
    const paragraph =
      '<paragraph><content startOffset="0" length="4"/></paragraph>';
    expect(
      (await readUdf(contentXml("Türk", paragraph.repeat(50)), 7)).unwrap(),
    ).toEqual({
      text: "Türk\nTü",
      truncated: true,
    });
    const invalidParagraph =
      '<paragraph><content startOffset="5" length="1"/></paragraph>';
    expect(
      (
        await readUdf(
          contentXml("Türk", paragraph.repeat(50) + invalidParagraph),
          7,
        )
      ).isErr(),
    ).toBe(true);
  });

  test.each([
    ["negative offset", '<content startOffset="-1" length="1"/>'],
    ["nondecimal offset", '<content startOffset="1e0" length="1"/>'],
    ["missing length", '<content startOffset="1"/>'],
    ["out-of-bounds length", '<content startOffset="1" length="6"/>'],
    ["unresolved field", '<field startOffset="0" length="0" default="Örnek"/>'],
    ["nested field", '<field><content startOffset="0" length="5"/></field>'],
    ["unknown component", '<unknown startOffset="0" length="1"/>'],
    ["image only", '<image startOffset="0" length="1"/>'],
  ])("rejects unreadable documents with %s", async (_case, element) => {
    expect(
      (
        await readUdf(contentXml("Örnek", `<paragraph>${element}</paragraph>`))
      ).isErr(),
    ).toBe(true);
  });

  test("requires the UYAP template and root archive entry", async () => {
    const xml = contentXml(
      "Örnek",
      '<paragraph><content startOffset="0" length="5"/></paragraph>',
    );
    expect((await readUdf(xml, 1024, "nested/content.xml")).isErr()).toBe(true);
    expect(
      (
        await readUdf(xml.replace('format_id="1.8"', 'format_id="9.0"'))
      ).isErr(),
    ).toBe(true);
  });
});
