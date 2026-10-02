import { Result } from "better-result";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import JSZip from "jszip";

import { API_FILE_SECURITY_REJECTED_ERROR_CODE } from "@stll/api-contract";

import { scanFile } from "@/api/lib/file-scan/scan";
import {
  FileScanFailedError,
  FileScanRejectedError,
  scanUpload,
} from "@/api/lib/file-scan/scan-upload";
import { scanUploadForHandler } from "@/api/lib/file-scan/scan-upload-handler";
import {
  DOCX_MIME_TYPE,
  PPTX_MIME_TYPE,
  XLSX_MIME_TYPE,
} from "@/api/mime-types";
import {
  largeDocx,
  largeXlsx,
  mediaHeavyDocx,
  mediaHeavyPptx,
} from "@/api/tests/helpers/large-ooxml";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";

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

// The large fixtures are generated and inflated in full.
setDefaultTimeout(120_000);

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

  test.each([
    ["an XLSX whose sheet inflates past 34 MiB", largeXlsx, XLSX_MIME_TYPE],
    ["a DOCX with 34 MiB of text", largeDocx, DOCX_MIME_TYPE],
    ["a DOCX carrying a 34 MiB image", mediaHeavyDocx, DOCX_MIME_TYPE],
    ["a PPTX carrying a 34 MiB video", mediaHeavyPptx, PPTX_MIME_TYPE],
  ])(
    "accepts %s after inspecting all of it",
    async (_name, build, mimeType) => {
      const scanned = Result.unwrap(
        await scanFile({
          buffer: await build(),
          declaredMimeType: mimeType,
          fileName: "large",
        }),
      );

      expect(scanned).toEqual({ verdict: "pass", findings: [] });
    },
  );

  test("rejects a rule match deep inside a large document", async () => {
    const bytes = await largeDocx({
      trailer:
        "<w:p><w:r><w:instrText>DDEAUTO marker</w:instrText></w:r></w:p>",
    });

    const scanned = await scanUpload({
      bytes,
      declaredMimeType: DOCX_MIME_TYPE,
      fileName: "large.docx",
    });
    if (!Result.isError(scanned)) {
      throw new TypeError("expected the scan to reject the file");
    }
    if (!FileScanRejectedError.is(scanned.error)) {
      throw new TypeError("expected a security rejection, not a scan failure");
    }
    expect(scanned.error.rejection.issues.map(({ code }) => code)).toEqual([
      "ooxml_dde",
    ]);
  });
});

describe("a refusal raised because inspection failed", () => {
  let analytics: RecordingAnalytics;
  beforeEach(() => {
    analytics = installRecordingAnalytics();
  });
  afterEach(() => {
    analytics.restore();
  });

  const defect = new TypeError("inspection defect");
  // The scan as the archive inspector answers a defect: a rejecting finding
  // that carries the error.
  const scanWithDefect: typeof scanFile = async () =>
    await Promise.resolve(
      Result.ok({
        verdict: "reject" as const,
        findings: [
          {
            rule: "archive-inspection-failed",
            severity: "reject" as const,
            message:
              "Archive inspection failed, so the file cannot be inspected",
            failure: defect,
          },
        ],
      }),
    );
  const input = {
    bytes: new Uint8Array([1, 2, 3]),
    declaredMimeType: DOCX_MIME_TYPE,
    fileName: "any.docx",
  };

  test("carries the error on the rejection", async () => {
    const scanned = await scanUpload(input, scanWithDefect);

    if (!Result.isError(scanned) || !FileScanRejectedError.is(scanned.error)) {
      throw new TypeError("expected a security rejection");
    }
    expect(scanned.error.inspectionFailures).toEqual([defect]);
  });

  test("answers with the typed rejection and reports the error", async () => {
    const result = await scanUploadForHandler(
      input,
      async (upload) => await scanUpload(upload, scanWithDefect),
    );

    if (!Result.isError(result)) {
      throw new TypeError("expected the scan to reject the file");
    }
    expect(result.error.status).toBe(422);
    expect(result.error.code).toBe(API_FILE_SECURITY_REJECTED_ERROR_CODE);
    expect(
      analytics.exceptions().map((event) => event.properties["error.class"]),
    ).toEqual(["TypeError"]);
  });

  test("reports nothing for an ordinary rejection", async () => {
    const result = await scanUploadForHandler({
      bytes: await attachedTemplateDocx(),
      declaredMimeType: DOCX_MIME_TYPE,
      fileName: "linked.docx",
    });

    expect(Result.isError(result)).toBe(true);
    expect(analytics.exceptions()).toEqual([]);
  });
});
