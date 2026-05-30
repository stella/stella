import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const translateDocumentMock = mock(async () => ({
  bytes: new Uint8Array([1, 2, 3]),
  billedCharacters: 3,
}));
const scanFileMock = mock(async () =>
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
const createEntityFromBufferMock = mock(async () =>
  Result.ok({
    entityId: toSafeId<"entity">("00000000-0000-0000-0000-000000000006"),
    fieldId: toSafeId<"field">("00000000-0000-0000-0000-000000000007"),
    fileName: "Translated.docx",
  }),
);
const captureErrorMock = mock(() => {});

void mock.module("@/api/lib/deepl/client", () => ({
  fetchTargetLanguages: mock(async () => []),
  maskDeepLKey: (key: string) => `${key.slice(0, 8)}****************`,
  resolveDeepLBaseUrl: () => "https://api.deepl.com",
  translateDocument: translateDocumentMock,
}));

void mock.module("@/api/lib/content-encryption", () => ({
  decryptContent: mock(async () => "deepl-key"),
}));

void mock.module("@/api/lib/s3", () => ({
  getS3: () => ({
    file: () => ({
      arrayBuffer: async () => new Uint8Array([80, 75, 3, 4]).buffer,
    }),
  }),
}));

void mock.module("@/api/lib/file-scan/scan", () => ({
  getScanWarnings: () => null,
  scanFile: scanFileMock,
}));

void mock.module("@/api/handlers/entities/create-from-buffer", () => ({
  createEntityFromBuffer: createEntityFromBufferMock,
}));

void mock.module("@/api/lib/analytics", () => ({
  captureError: captureErrorMock,
  captureRequestError: mock(() => {}),
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

const createContext = (): TranslateEntityCtx => {
  const tx = {
    query: {
      organizationSettings: {
        findFirst: async () => ({
          deeplApiKeyEncrypted: Buffer.from("ciphertext"),
          deeplApiKeyIv: Buffer.from("iv"),
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
                    id: "source-file-id",
                    fileName: "Source.docx",
                    mimeType: DOCX_MIME_TYPE,
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
    activeWorkspaceIds: [workspaceId],
    accessibleWorkspaces: [],
    orgAIConfig: null,
    promptCachingEnabled: true,
    request: new Request("http://localhost/entities/test/translate"),
    route: "/entities/:workspaceId/translate",
  });
};

describe("translateEntity", () => {
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
    expect(scanFileMock).toHaveBeenCalledTimes(1);
    expect(createEntityFromBufferMock).not.toHaveBeenCalled();
  });
});
