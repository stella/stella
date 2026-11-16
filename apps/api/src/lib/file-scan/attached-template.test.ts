import { expect, test } from "bun:test";

import { ZipArchive } from "@stll/docx-core/zip";
import { OFFICE_ARCHIVE_FORMATS } from "@stll/docx-utils/office-formats";

import { attachedTemplateScanner } from "./attached-template";

const wordFormats = Object.entries(OFFICE_ARCHIVE_FORMATS).filter(
  ([, format]) => format.family === "word",
);
test.each(wordFormats)(
  "inspects template relationships in the canonical Word format %s",
  async (extension, format) => {
    const zip = new ZipArchive();
    zip.set(
      "word/_rels/document.xml.rels",
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://templates.example.test/template.dotx" TargetMode="External"/></Relationships>',
    );
    const bytes = await zip.generate({ compression: "store" });
    for (const context of [
      {
        filename: `fixture.${extension.toUpperCase()}`,
        mimeType: "application/octet-stream",
      },
      { filename: "fixture", mimeType: format.mimeType },
    ]) {
      const findings = await attachedTemplateScanner.scan(bytes, context);
      expect(findings.map(({ rule }) => rule)).toContain(
        "ooxml_attached_template",
      );
    }
  },
);
