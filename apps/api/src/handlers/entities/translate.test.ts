import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { envBase } from "@/api/env-base";
import { toSafeId } from "@/api/lib/branded-types";
import { encryptContent } from "@/api/lib/content-encryption";
import { createFileKey } from "@/api/lib/file-key";
import { DOC_MIME_TYPE, DOCX_MIME_TYPE } from "@/api/mime-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const translateDocumentMock = mock(async (_input: { apiKey: string }) => ({
  bytes: new Uint8Array([1, 2, 3]),
  billedCharacters: 3,
}));

type ScanFileInput = {
  buffer: Uint8Array;
  declaredMimeType: string;
  fileName: string;
};

const scanFileMock = mock(async (_input: ScanFileInput) =>
  Result.ok({
    verdict: "reject" as const,
    findings: [
      {
        rule: "mime-magic-mismatch",
        severity: "reject" as const,
        message:
          "File declared as application/vnd.openxmlformats-officedocument.wordprocessingml.document but its content does not match that type",
      },
    ],
  }),
);
const processExtractionMock = mock(async () => {});
const enqueueImageThumbnailMock = mock(async () => {});
const enqueueImageThumbnailOrMarkFailedMock = mock(async () => {});
const enqueuePdfDerivativeMock = mock(async () => {});
const enqueuePdfDerivativeOrMarkFailedMock = mock(async () => {});

const realDeepLClient = await import("@/api/lib/deepl/client");
void mock.module("@/api/lib/deepl/client", () => ({
  ...realDeepLClient,
  fetchTargetLanguages: mock(async () => []),
  maskDeepLKey: (key: string) => `${key.slice(0, 8)}****************`,
  resolveDeepLBaseUrl: () => "https://api.deepl.com",
  translateDocument: translateDocumentMock,
  translateTextBatch: mock(async () => []),
  translateTextBatches: mock(async () => []),
}));

void mock.module("@/api/lib/file-scan/scan", () => ({
  getScanWarnings: () => null,
  scanFile: scanFileMock,
}));

void mock.module("@/api/lib/search/process-extraction", () => ({
  processExtraction: processExtractionMock,
  requestNativeExtractionRun: mock(async () => null),
}));

const realFileDerivativeQueue = await import("@/api/lib/file-derivative-queue");
void mock.module("@/api/lib/file-derivative-queue", () => ({
  ...realFileDerivativeQueue,
  enqueueImageThumbnail: enqueueImageThumbnailMock,
  enqueueImageThumbnailOrMarkFailed: enqueueImageThumbnailOrMarkFailedMock,
  enqueuePdfDerivative: enqueuePdfDerivativeMock,
  enqueuePdfDerivativeOrMarkFailed: enqueuePdfDerivativeOrMarkFailedMock,
  initFileDerivativeWorker: mock(() => undefined),
}));

const translateEntity = (await import("./translate")).default;

type TranslateEntityCtx = Parameters<typeof translateEntity.handler>[0];

const organizationId = toSafeId<"organization">(
  "00000000-0000-0000-0000-000000000001",
);
const workspaceId = toSafeId<"workspace">(
  "00000000-0000-0000-0000-000000000002",
);
const fieldId = toSafeId<"field">("00000000-0000-0000-0000-000000000003");
const userId = toSafeId<"user">("00000000-0000-0000-0000-000000000004");

const sourceFileId = "source-file-id";
const DEEPL_API_KEY = "deepl-key";
// The row holds a real AES-GCM envelope, so the handler's own decryption is
// what hands the key to the provider.
const storedDeepLKey = await encryptContent(organizationId, DEEPL_API_KEY);
// A DOCX magic prefix: the source object is read back through the real S3
// helper, so the bytes the provider receives are the bytes in the store.
const sourceBytes = new Uint8Array([80, 75, 3, 4]);

let fake: FakeS3;

type CreateContextOptions = {
  sourceFileName?: string | undefined;
  sourceMimeType?: string | undefined;
};

const createContext = ({
  sourceFileName = "Source.docx",
  sourceMimeType = DOCX_MIME_TYPE,
}: CreateContextOptions = {}): TranslateEntityCtx => {
  fake.put(
    envBase.S3_BUCKET,
    createFileKey({
      organizationId,
      workspaceId,
      fileId: sourceFileId,
      mimeType: sourceMimeType,
    }),
    sourceBytes,
    sourceMimeType,
  );

  const tx = {
    query: {
      organizationSettings: {
        findFirst: async () => ({
          deeplApiKeyEncrypted: storedDeepLKey.ciphertext,
          deeplApiKeyIv: storedDeepLKey.iv,
        }),
      },
    },
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: async () => [
                {
                  content: {
                    type: "file" as const,
                    version: 1 as const,
                    id: sourceFileId,
                    fileName: sourceFileName,
                    mimeType: sourceMimeType,
                    sizeBytes: 4,
                    encrypted: false,
                    sha256Hex: "hash",
                    pdfFileId: null,
                    pdfDerivative: { status: "pending" as const },
                  },
                },
              ],
            }),
          }),
        }),
      }),
    }),
  };
  const { safeDb, scopedDb } = createScopedDbMock(tx);

  return asTestRaw<TranslateEntityCtx>({
    body: {
      fieldId,
      targetLang: "DE",
      formality: "prefer_more",
    },
    safeDb,
    scopedDb,
    session: { activeOrganizationId: organizationId },
    workspaceId,
    user: { id: userId },
    recordAuditEvent: async () => {},
    memberRole: { role: "owner" },
    getActiveWorkspaceIds: async () => [workspaceId],
    getAccessibleWorkspaces: async () => [],
    getWorkspaceAccess: async () => null,
    orgAIConfig: null,
    promptCachingEnabled: true,
    request: new Request("http://localhost/entities/test/translate"),
    route: "/entities/:workspaceId/translate",
  });
};

describe("translateEntity", () => {
  let analytics: RecordingAnalytics;

  beforeEach(() => {
    analytics = installRecordingAnalytics();
    fake = startFakeS3();
    translateDocumentMock.mockClear();
    scanFileMock.mockClear();
    processExtractionMock.mockClear();
    enqueuePdfDerivativeOrMarkFailedMock.mockClear();
  });

  afterEach(() => {
    analytics.restore();
    fake.stop();
  });

  test("rejects translated provider output that fails the file security scan", async () => {
    const result = await translateEntity.handler(createContext());

    expect(result).toEqual({
      code: 422,
      response: {
        message:
          "Translated file rejected: File declared as application/vnd.openxmlformats-officedocument.wordprocessingml.document but its content does not match that type",
      },
    });
    expect(translateDocumentMock).toHaveBeenCalledTimes(1);
    // The provider is called with the key the handler decrypted, and with the
    // exact bytes the store holds for the source object.
    expect(translateDocumentMock.mock.calls.at(0)?.at(0)).toMatchObject({
      apiKey: DEEPL_API_KEY,
      file: sourceBytes,
    });
    expect(scanFileMock).toHaveBeenCalledTimes(1);
    // A rejected scan leaves the store exactly as it was: no translated
    // object written, and nothing deleted.
    expect([...fake.objects.keys()]).toEqual([
      `${envBase.S3_BUCKET}/${createFileKey({
        organizationId,
        workspaceId,
        fileId: sourceFileId,
        mimeType: DOCX_MIME_TYPE,
      })}`,
    ]);
    expect(fake.requests.filter(({ method }) => method !== "GET")).toHaveLength(
      0,
    );
    expect(processExtractionMock).not.toHaveBeenCalled();
    expect(enqueuePdfDerivativeOrMarkFailedMock).not.toHaveBeenCalled();
    // A scan verdict is an expected outcome the caller is told about, not a
    // defect: nothing is reported as an exception.
    expect(analytics.exceptions()).toEqual([]);
  });

  test("scans legacy DOC provider output as DOCX before persistence", async () => {
    await translateEntity.handler(
      createContext({
        sourceFileName: "Source.doc",
        sourceMimeType: DOC_MIME_TYPE,
      }),
    );

    expect(scanFileMock.mock.calls).toHaveLength(1);
    expect(scanFileMock.mock.calls.at(0)?.[0]).toMatchObject({
      declaredMimeType: DOCX_MIME_TYPE,
      fileName: "Source (DE).docx",
    });
    // The legacy source is read under its own `.doc` key and nothing is
    // written back for the rejected translation.
    expect(fake.requests).toEqual([
      {
        method: "GET",
        bucket: envBase.S3_BUCKET,
        key: createFileKey({
          organizationId,
          workspaceId,
          fileId: sourceFileId,
          mimeType: DOC_MIME_TYPE,
        }),
        contentType: null,
        copySourceKey: null,
      },
    ]);
  });
});
