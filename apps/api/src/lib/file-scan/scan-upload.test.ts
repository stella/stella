import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { API_FILE_SECURITY_REJECTED_ERROR_CODE } from "@stll/api-contract";

import {
  FileScanFailedError,
  scanUploadForHandler,
} from "@/api/lib/file-scan/scan-upload";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const attachedTemplateDocx = async (): Promise<Uint8Array> => {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      "<w:body><w:p><w:r><w:t>Body</w:t></w:r></w:p></w:body></w:document>",
  );
  zip.file(
    "word/_rels/document.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" ' +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" ' +
      'Target="https://templates.example/remote.dotm" TargetMode="External"/>' +
      "</Relationships>",
  );
  return await zip.generateAsync({ type: "uint8array" });
};

describe("scanUploadForHandler", () => {
  test("answers a rejected file with the structured 422", async () => {
    const result = await scanUploadForHandler({
      bytes: await attachedTemplateDocx(),
      declaredMimeType: DOCX_MIME_TYPE,
      fileName: "linked.docx",
    });

    if (!Result.isError(result)) {
      throw new TypeError("expected the scan to reject the file");
    }
    expect(result.error.status).toBe(422);
    expect(result.error.code).toBe(API_FILE_SECURITY_REJECTED_ERROR_CODE);
  });

  test("answers a scanner failure with a retryable 503, not a verdict on the file", async () => {
    const result = await scanUploadForHandler(
      {
        bytes: new Uint8Array([1, 2, 3]),
        declaredMimeType: DOCX_MIME_TYPE,
        fileName: "any.docx",
      },
      async () =>
        await Promise.resolve(
          Result.err(new FileScanFailedError({ message: "scanner down" })),
        ),
    );

    if (!Result.isError(result)) {
      throw new TypeError("expected the scan to fail");
    }
    expect(result.error.status).toBe(503);
    expect(result.error.code).not.toBe(API_FILE_SECURITY_REJECTED_ERROR_CODE);
    expect(result.error.hint).toContain("Retry");
  });
});
