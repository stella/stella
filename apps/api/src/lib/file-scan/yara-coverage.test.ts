/**
 * Coverage contract: every compiled rule has a positive fixture that it
 * matches through the full `scanFile` pipeline, and no rule matches any of
 * the benign fixtures. Rule names are read from the rule files, so a new
 * rule fails this test until a fixture is written for it.
 */
import { PDF } from "@libpdf/core";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { compileLegalSourceToDocx } from "@stll/docx-core";

import { scanFile } from "@/api/lib/file-scan/scan";
import { yaraRuleNames } from "@/api/lib/file-scan/yara";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const encoder = new TextEncoder();

type Fixture = {
  buffer: Uint8Array;
  declaredMimeType: string;
  fileName: string;
};

const pdf = async (payload = ""): Promise<Fixture> => {
  const doc = PDF.create();
  doc.addPage();
  const base = await doc.save();
  const extra = encoder.encode(payload);
  const buffer = new Uint8Array(base.length + extra.length);
  buffer.set(base);
  buffer.set(extra, base.length);
  return { buffer, declaredMimeType: "application/pdf", fileName: "f.pdf" };
};

/** DEFLATE-compressed, as a real OOXML writer produces. */
const docx = async (files: Record<string, string>): Promise<Fixture> => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types></Types>');
  zip.file("word/document.xml", "<document/>");
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  return {
    buffer: await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
    }),
    declaredMimeType: DOCX_MIME,
    fileName: "f.docx",
  };
};

const svg = (body: string): Fixture => ({
  buffer: encoder.encode(
    `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`,
  ),
  declaredMimeType: "image/svg+xml",
  fileName: "f.svg",
});

/** Signature bytes past the 64-byte offset the executable rules require. */
const embedded = (signature: readonly number[]): Fixture => {
  const buffer = new Uint8Array(512);
  buffer.set(signature, 100);
  return {
    buffer,
    declaredMimeType: "application/octet-stream",
    fileName: "f.bin",
  };
};

const RELS = "word/_rels/document.xml.rels";

const POSITIVE_FIXTURES: Record<string, () => Promise<Fixture> | Fixture> = {
  pdf_javascript_js: async () => await pdf("<</S/JS/JS (alert(1))>>"),
  pdf_javascript_full: async () => await pdf("<</S/JavaScript 5 0 R>>"),
  pdf_xfa_form_javascript: async () =>
    await pdf("<</AcroForm<</XFA 5 0 R>>>>\n<</S/JavaScript/JS (f())>>"),
  pdf_launch: async () => await pdf("<</F(cmd.exe)/S/Launch>>"),
  pdf_submit_form: async () => await pdf("<</F(http://x)/S/SubmitForm>>"),
  pdf_goto_remote: async () => await pdf("<</F(r.pdf)/S/GoToR>>"),
  pdf_goto_embedded: async () => await pdf("<</D(p)/S/GoToE>>"),
  pdf_rich_media: async () => await pdf("<</Subtype/Flash/S/RichMedia>>"),
  pdf_embedded_file: async () => await pdf("<</Type/EmbeddedFile>>"),
  pdf_open_action_uri: async () =>
    await pdf("<</OpenAction<</S/URI/URI(http://x)>>>>"),

  svg_script_tag: () => svg("<script>alert(1)</script>"),
  svg_event_handler: () => svg('<rect onload="alert(1)"/>'),
  svg_foreign_object: () => svg("<foreignObject><b>x</b></foreignObject>"),
  svg_javascript_uri: () => svg('<a href="javascript:alert(1)">x</a>'),
  svg_external_reference: () => svg('<use xlink:href="https://e.example/#i"/>'),

  embedded_pe_executable: () =>
    embedded([0x4d, 0x5a, 0x00, 0x00, 0x50, 0x45, 0x00, 0x00]),
  embedded_elf: () => embedded([0x7f, 0x45, 0x4c, 0x46]),
  embedded_macho_64: () => embedded([0xcf, 0xfa, 0xed, 0xfe]),
  embedded_macho_32: () => embedded([0xce, 0xfa, 0xed, 0xfe]),

  ole2_container: () => ({
    buffer: new Uint8Array([
      0xd0,
      0xcf,
      0x11,
      0xe0,
      0xa1,
      0xb1,
      0x1a,
      0xe1,
      ...new Uint8Array(248),
    ]),
    declaredMimeType: "application/msword",
    fileName: "f.doc",
  }),
  ooxml_macros: async () => await docx({ "word/vbaProject.bin": "VBA" }),
  office_macro_suspicious_words: async () =>
    await docx({
      "word/vbaProject.bin":
        'Sub AutoOpen()\n Set o = CreateObject("WScript.Shell")\nEnd Sub',
    }),

  ooxml_xxe_entity: async () =>
    await docx({
      "word/settings.xml":
        '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x/>',
    }),
  ooxml_external_relationship: async () =>
    await docx({
      [RELS]:
        '<Relationships><Relationship Id="rId4" ' +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/' +
        'relationships/oleObject" Target="https://e.example/p" ' +
        'TargetMode="External"/></Relationships>',
    }),
  ooxml_remote_template: async () =>
    await docx({
      [RELS]:
        '<Relationships><Relationship Type="attachedTemplate" ' +
        'Target="https://e.example/t.dotm"/></Relationships>',
    }),
  ooxml_dde: async () =>
    await docx({
      "word/document.xml":
        "<w:document><w:instrText>DDEAUTO cmd.exe</w:instrText></w:document>",
    }),
  ooxml_activex: async () =>
    await docx({ "word/activeX/activeX1.xml": '<ax:ocx r:id="rId1"/>' }),
  ooxml_ole_object: async () =>
    await docx({ "word/embeddings/oleObject1.bin": "OLE" }),
};

const scanFixture = async (fixture: Fixture): Promise<readonly string[]> =>
  Result.unwrap(await scanFile(fixture)).findings.map((f) => f.rule);

describe("yara rule coverage", () => {
  test("every compiled rule has a positive fixture", () => {
    const uncovered = yaraRuleNames.filter(
      (rule) => !(rule in POSITIVE_FIXTURES),
    );
    expect(uncovered).toEqual([]);
  });

  test("no fixture exists for a rule that was removed", () => {
    const orphaned = Object.keys(POSITIVE_FIXTURES).filter(
      (rule) => !yaraRuleNames.includes(rule),
    );
    expect(orphaned).toEqual([]);
  });

  test.each(Object.entries(POSITIVE_FIXTURES))(
    "%s matches its fixture",
    async (rule, build) => {
      expect(await scanFixture(await build())).toContain(rule);
    },
  );
});

describe("benign fixtures match no rule", () => {
  const benign: Record<string, () => Promise<Fixture> | Fixture> = {
    "clean pdf": async () => await pdf(),
    "clean docx": async () => {
      const compiled = await compileLegalSourceToDocx(
        ["@title Test", "", "@paragraph", "text"].join("\n"),
        { titleFallback: "Test" },
      );
      if (compiled.status !== "ok") {
        throw new Error("Failed to compile clean DOCX fixture");
      }
      return {
        buffer: new Uint8Array(compiled.buffer),
        declaredMimeType: DOCX_MIME,
        fileName: "clean.docx",
      };
    },
    "docx whose only external relationship is a hyperlink": async () =>
      await docx({
        [RELS]:
          '<Relationships><Relationship Id="rId4" ' +
          'Type="http://schemas.openxmlformats.org/officeDocument/2006/' +
          'relationships/hyperlink" Target="https://e.example/" ' +
          'TargetMode="External"/></Relationships>',
      }),
    "docx whose single-quoted external relationship is a hyperlink": async () =>
      await docx({
        [RELS]:
          "<Relationships><Relationship Id='rId4' " +
          "Type='http://schemas.openxmlformats.org/officeDocument/2006/" +
          "relationships/hyperlink' Target='https://e.example/' " +
          "TargetMode='External'/></Relationships>",
      }),
    "pdf naming an object whose name only starts with /JavaScript": async () =>
      await pdf("<</AcroForm<</XFA 5 0 R>>>>\n<</JavaScriptBackup 5 0 R>>"),
    "clean svg": () => svg("<rect width='1' height='1'/>"),
    "plain text": () => ({
      buffer: encoder.encode("Smlouva o dílo\nArticle 1\n"),
      declaredMimeType: "text/plain",
      fileName: "notes.txt",
    }),
  };

  test.each(Object.entries(benign))("%s", async (_name, build) => {
    const rules = await scanFixture(await build());
    expect(rules.filter((rule) => yaraRuleNames.includes(rule))).toEqual([]);
  });
});
