import { panic, Result } from "better-result";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import type { Mock } from "bun:test";

import { API_FILE_SECURITY_REJECTED_ERROR_CODE } from "@stll/api-contract";

import type { ScopedDb } from "@/api/db/safe-db";
import { fillHandler } from "@/api/handlers/templates/fill";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import * as scanModule from "@/api/lib/file-scan/scan-upload";
import {
  FileScanFailedError,
  FileScanRejectedError,
} from "@/api/lib/file-scan/scan-upload";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import * as conversionModule from "@/api/lib/files/gotenberg";
import * as recordModule from "@/api/lib/templates/record-use";
import * as inputScanModule from "@/api/lib/templates/scan-template-upload";
import * as fillModule from "@/api/lib/templates/template-fill-service";
import type { FilledDocx } from "@/api/lib/templates/template-fill-service";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import {
  testDocxFile,
  testScannedFile,
} from "@/api/tests/helpers/scanned-file";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { fillByIdLogic } from "./fill-by-id-logic";
import { scanTemplateOutput } from "./validate-template-output";

const organizationId = toSafeId<"organization">("org_template_scan");
const userId = toSafeId<"user">("user_template_scan");
const templateId = toSafeId<"template">("template_scan");
const bytes = new TextEncoder().encode("rendered document fixture");
const filledFile = testDocxFile(bytes);
const filled = {
  templateName: "Template",
  fileName: "template.docx",
  file: filledFile,
  unmatchedPlaceholders: [],
  unusedValues: [],
  structureErrors: [],
  aiFieldErrors: [],
  conditionDecisions: [],
  clauseWarnings: [],
} satisfies FilledDocx;
const failure = new FileScanFailedError({
  message: "scanner unavailable",
  cause: new Error("private scanner cause"),
});
const rejected = new FileScanRejectedError({
  message: "Output rejected",
  rejection: {
    code: API_FILE_SECURITY_REJECTED_ERROR_CODE,
    message: "Output rejected",
    hint: "Review output",
    issues: [],
  },
  inspectionFailures: [],
});
const rejectedInspection = new FileScanRejectedError({
  message: rejected.message,
  rejection: rejected.rejection,
  inspectionFailures: [new Error("private inspection cause")],
});
const passFile = testScannedFile({
  bytes: bytes.slice().buffer,
  mimeType: DOCX_MIME_TYPE,
  scan: { verdict: "pass", findings: [] },
});
const warnFile = testScannedFile({
  bytes: bytes.slice().buffer,
  mimeType: DOCX_MIME_TYPE,
  scan: {
    verdict: "warn",
    findings: [
      { rule: "fixture-warning", severity: "warn", message: "Output warning" },
    ],
  },
});

const cases = [
  { name: "pass", scan: Result.ok(passFile), status: 200, scanExceptions: 0 },
  {
    name: "warning",
    scan: Result.ok(warnFile),
    status: 422,
    scanExceptions: 0,
  },
  {
    name: "rejection",
    scan: Result.err(rejected),
    status: 422,
    scanExceptions: 0,
  },
  {
    name: "rejection with inspection failure",
    scan: Result.err(rejectedInspection),
    status: 422,
    scanExceptions: 1,
  },
  {
    name: "inspection failure",
    scan: Result.err(failure),
    status: 503,
    scanExceptions: 0,
  },
] satisfies {
  name: string;
  scan: Result<ScannedFile, FileScanFailedError | FileScanRejectedError>;
  status: number;
  scanExceptions: number;
}[];

let scan: Mock<typeof scanModule.scanUpload>;
let convert: Mock<typeof conversionModule.convertToPdf>;
let scanInput: Mock<typeof inputScanModule.scanTemplateUpload>;
let fill: Mock<typeof fillModule.fillTemplateDocx>;
let loadSource: Mock<typeof fillModule.loadStoredTemplateSource>;
let recordFill: Mock<typeof recordModule.recordTemplateFill>;
let recordUse: Mock<typeof recordModule.recordTemplateUse>;
let analytics: ReturnType<typeof installRecordingAnalytics>;
let pending: Promise<void>[] = [];

beforeEach(() => {
  recordUse = spyOn(recordModule, "recordTemplateUse");
  recordFill = spyOn(recordModule, "recordTemplateFill");
  loadSource = spyOn(fillModule, "loadStoredTemplateSource");
  fill = spyOn(fillModule, "fillTemplateDocx");
  scanInput = spyOn(inputScanModule, "scanTemplateUpload");
  convert = spyOn(conversionModule, "convertToPdf");
  scan = spyOn(scanModule, "scanUpload");
  analytics = installRecordingAnalytics();
  pending = [];
  convert.mockResolvedValue(
    Result.ok({
      buffer: new Uint8Array([37, 80, 68, 70]).buffer,
      sizeBytes: 4,
    }),
  );
  scanInput.mockResolvedValue(Result.ok(filledFile));
  fill.mockResolvedValue(filled);
  loadSource.mockResolvedValue(
    Result.ok({
      name: "Template",
      fileName: "template.docx",
      file: filledFile,
    }),
  );
  recordFill.mockImplementation(async () => {});
  recordUse.mockImplementation(async () => {});
});

// Every imported I/O/engine spy is recreated and restored per test.
afterEach(async () => {
  try {
    await Promise.all(pending);
  } finally {
    analytics.restore();
    mock.restore();
  }
});

const context = () => {
  const base = createScopedDbMock({});
  const scopedDb: ScopedDb = async (callback) => {
    const operation = base.scopedDb(callback);
    pending.push(operation.then(() => undefined));
    return await operation;
  };
  return { organizationId, userId, scopedDb, safeDb: base.safeDb };
};

const assertConversion = (status: number) => {
  expect(convert).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
  if (status === 200) {
    expect(convert).toHaveBeenCalledWith(passFile);
  }
};

describe("template PDF output inspection", () => {
  test.each(cases)("output owner preserves $name", async (item) => {
    scan.mockResolvedValue(item.scan);
    const outcome = await scanTemplateOutput({
      buffer: bytes,
      fileName: "template.docx",
    });
    expect(scan).toHaveBeenCalledWith({
      bytes,
      declaredMimeType: DOCX_MIME_TYPE,
      fileName: "template.docx",
    });
    if (item.status === 503) {
      expect(Result.isError(outcome)).toBe(true);
      if (!Result.isError(outcome)) {
        panic("Expected scanner failure");
      }
      expect(outcome.error).toBe(failure);
    } else {
      expect(Result.unwrap(outcome)).toBe(
        item.status === 200 ? passFile : null,
      );
    }
    expect(analytics.exceptions()).toHaveLength(item.scanExceptions);
  });

  test.each(cases)("raw PDF download answers $name", async (item) => {
    scan.mockResolvedValue(item.scan);
    const response = await fillHandler({
      ...context(),
      body: {
        file: new File([bytes], "template.docx", { type: DOCX_MIME_TYPE }),
        values: "{}",
      },
      query: { format: "pdf" },
    });
    expect(response.status).toBe(item.status);
    assertConversion(item.status);
    const body = await response.text();
    expect(body).not.toContain("private scanner cause");
    expect(body).not.toContain("private inspection cause");
    expect(analytics.exceptions()).toHaveLength(
      item.status === 503 ? 1 : item.scanExceptions,
    );
    if (item.status === 503) {
      expect(JSON.parse(body)).toMatchObject({
        code: "internal_error",
        message: "File security scan is unavailable",
        hint: "Retry the template PDF export.",
      });
    }
  });

  test.each(cases)("stored PDF download answers $name", async (item) => {
    scan.mockResolvedValue(item.scan);
    const outcome = await Result.gen(() =>
      fillByIdLogic({
        ...context(),
        templateId,
        body: { values: {} },
        query: { format: "pdf" },
        recordAuditEvent: async () => {},
      }),
    );
    assertConversion(item.status);
    expect(analytics.exceptions()).toHaveLength(item.scanExceptions);
    if (item.status === 200) {
      expect(Result.isOk(outcome)).toBe(true);
    } else {
      expect(Result.isError(outcome)).toBe(true);
      if (!Result.isError(outcome)) {
        panic("Expected output refusal");
      }
      expect(outcome.error).toBeInstanceOf(HandlerError);
      if (!(outcome.error instanceof HandlerError)) {
        panic("Expected handler refusal");
      }
      expect(item.status).toBe(outcome.error.status);
      if (item.status === 503) {
        expect(outcome.error.code).toBe("internal_error");
        expect(outcome.error.hint).toContain("Retry");
        expect(outcome.error.cause).toBe(failure);
      }
    }
  });
});

test.each(["raw", "stored"] as const)(
  "%s DOCX download does not inspect or convert rendered output",
  async (surface) => {
    scan.mockResolvedValue(Result.err(failure));
    if (surface === "raw") {
      const response = await fillHandler({
        ...context(),
        body: {
          file: new File([bytes], "template.docx", { type: DOCX_MIME_TYPE }),
          values: "{}",
        },
        query: { format: "docx" },
      });
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    } else {
      const result = Result.unwrap(
        await Result.gen(() =>
          fillByIdLogic({
            ...context(),
            templateId,
            body: { values: {} },
            query: { format: "docx" },
            recordAuditEvent: async () => {},
          }),
        ),
      );
      expect(new Uint8Array(result.body)).toEqual(bytes);
    }
    expect(scan).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
  },
);
