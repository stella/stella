import { panic, Result } from "better-result";
import { expect, spyOn, test } from "bun:test";

import { ZipArchive } from "@stll/docx-core/zip";
import { OFFICE_ARCHIVE_FORMATS } from "@stll/docx-utils/office-formats";

import { scanFile } from "@/api/lib/file-scan/scan";
import {
  FileScanRejectedError,
  scanUpload,
} from "@/api/lib/file-scan/scan-upload";
import { scanErrorForHandler } from "@/api/lib/file-scan/scan-upload-handler";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";

import { attachedTemplateScanner } from "./attached-template";

const wordFormats = Object.entries(OFFICE_ARCHIVE_FORMATS).filter(
  ([, format]) => format.family === "word",
);

test("an unreadable Word relationship inspection refuses the upload and reports its cause", async () => {
  const zip = new ZipArchive();
  zip.set(
    "[Content_Types].xml",
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.set(
    "_rels/.rels",
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.set(
    "word/document.xml",
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Document body</w:t></w:r></w:p></w:body></w:document>',
  );
  zip.set(
    "word/_rels/document.xml.rels",
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
  );
  const bytes = await zip.generate({ compression: "store" });
  const context = { filename: "document.docx", mimeType: DOCX_MIME_TYPE };
  const input = {
    bytes,
    declaredMimeType: DOCX_MIME_TYPE,
    fileName: context.filename,
  };
  expect(
    (
      await scanFile({
        buffer: bytes,
        declaredMimeType: DOCX_MIME_TYPE,
        fileName: context.filename,
      })
    ).unwrap().verdict,
  ).toBe("pass");
  const cause = new TypeError("Word relationship inspection unavailable");
  const analytics = installRecordingAnalytics();
  const read = spyOn(ZipArchive, "read").mockRejectedValue(cause);
  try {
    const scanned = (
      await scanFile({
        buffer: bytes,
        declaredMimeType: DOCX_MIME_TYPE,
        fileName: context.filename,
      })
    ).unwrap();
    expect(scanned.verdict).toBe("reject");
    expect(
      scanned.findings.find(
        ({ rule }) => rule === "ooxml_relationships_unreadable",
      )?.failure,
    ).toBe(cause);
    expect(await attachedTemplateScanner.scan(bytes, context)).toMatchObject([
      { rule: "ooxml_relationships_unreadable", failure: cause },
    ]);
    const upload = await scanUpload(input);
    if (Result.isOk(upload)) {
      panic("Expected an inspection refusal");
    }
    expect(FileScanRejectedError.is(upload.error)).toBe(true);
    if (!FileScanRejectedError.is(upload.error)) {
      panic("Expected a typed inspection refusal");
    }
    expect(upload.error.inspectionFailures).toEqual([cause]);
    const response = scanErrorForHandler(upload.error, "Retry the upload");
    expect(response.status).toBe(422);
    expect(
      analytics.exceptions().map(({ properties }) => properties["error.class"]),
    ).toEqual(["TypeError"]);
    expect(JSON.stringify(response)).not.toContain(cause.message);
  } finally {
    read.mockRestore();
    analytics.restore();
  }
});

test("non-Word bytes do not require Word relationship inspection", async () => {
  const read = spyOn(ZipArchive, "read").mockRejectedValue(
    new Error("unused inspection"),
  );
  try {
    expect(
      await attachedTemplateScanner.scan(
        new TextEncoder().encode("Plain text"),
        { filename: "document.txt", mimeType: "text/plain" },
      ),
    ).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});
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
