import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { toSafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import type { ExtractAskContentsArgs } from "@/api/lib/document-review/review-extract";
import { LIMITS } from "@/api/lib/limits";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  createFolderConsistencyReviewTools,
  isCitableReviewFile,
  REVIEW_FOLDER_CONSISTENCY_TOOL_NAME,
} from "./folder-consistency-review-tool";

const workspaceId = toSafeId<"workspace">(
  "11111111-1111-4111-8111-111111111111",
);
const organizationId = toSafeId<"organization">(
  "22222222-2222-4222-8222-222222222222",
);
const userId = toSafeId<"user">("33333333-3333-4333-8333-333333333333");
const folderId = toSafeId<"entity">("44444444-4444-4444-8444-444444444444");
const otherWorkspaceId = toSafeId<"workspace">(
  "55555555-5555-4555-8555-555555555555",
);

const indexedId = (index: number) =>
  `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`;

const documentRows = Array.from(
  { length: LIMITS.folderConsistencyReviewDocumentsMax + 1 },
  (_, index) => ({
    id: indexedId(index + 10),
    kind: "document",
    name: `Document ${index + 1}`,
    depth: 1,
  }),
);

const fieldIdAt = (index: number) =>
  toSafeId<"field">(
    `${String(index + 40).padStart(8, "0")}-0000-4000-8000-000000000000`,
  );

const createFileContent = (index: number) => ({
  version: 1 as const,
  type: "file" as const,
  id: `${String(index + 70).padStart(8, "0")}-0000-4000-8000-000000000000`,
  fileName: `document-${index + 1}.pdf`,
  mimeType: "application/pdf",
  sizeBytes: 1,
  encrypted: false,
  sha256Hex: "a".repeat(64),
  pdfFileId: null,
});

const createSafeDb = (): SafeDb => {
  const tx = {
    execute: async () => documentRows,
    query: {
      entities: {
        findFirst: async () => ({ kind: "folder", name: "Loan security" }),
        findMany: async () =>
          documentRows
            .slice(0, LIMITS.folderConsistencyReviewDocumentsMax)
            .map((row, index) => ({
              id: toSafeId<"entity">(row.id),
              name: row.name,
              currentVersion: {
                id: toSafeId<"entityVersion">(indexedId(index + 100)),
                fields: [
                  { id: fieldIdAt(index), content: createFileContent(index) },
                ],
              },
            })),
      },
    },
  };
  return async (callback) =>
    Result.ok(await callback(asTestRaw<Transaction>(tx)));
};

describe("review_folder_consistency", () => {
  test("excludes native Office text unless it has a citable PDF derivative", () => {
    const officeFile = {
      fileFieldId: fieldIdAt(0),
      fileId: createFileContent(0).id,
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sha256Hex: "a".repeat(64),
      encrypted: false,
      pdfFileId: null,
    };

    expect(isCitableReviewFile(officeFile)).toBe(false);
    expect(
      isCitableReviewFile({
        ...officeFile,
        pdfFileId: "99999999-9999-4999-8999-999999999999",
      }),
    ).toBe(true);
  });

  test("keeps folder coverage explicit and emits only verified source refs", async () => {
    const refRegistry = createChatRefRegistry();
    const folderRef = refRegistry.toEntityRef({
      entityId: folderId,
      workspaceId,
    });
    const extractAskContentsFn = async (args: ExtractAskContentsArgs) => {
      expect(args.resolvedFiles).toHaveLength(
        LIMITS.folderConsistencyReviewDocumentsMax,
      );
      return Result.ok({
        lastBlockId: null,
        contentBySourceId: new Map([
          [
            "cross-document-consistency",
            {
              content: {
                type: "text" as const,
                version: 1 as const,
                value: "The principal and guarantee amounts conflict.",
              },
              citations: [
                {
                  kind: "pdf-bates" as const,
                  fileFieldId: fieldIdAt(0),
                  statement: "Principal is CZK 10,000,000.",
                  bates: "F0-0002",
                  pageNumber: 2,
                },
                {
                  kind: "docx-folio" as const,
                  fileFieldId: fieldIdAt(1),
                  statement: "Guarantee is CZK 8,000,000.",
                  blockId: "A1B2C3D4",
                  text: "Ručitel ručí do výše 8 000 000 Kč.",
                },
              ],
            },
          ],
        ]),
      });
    };
    const tools = createFolderConsistencyReviewTools({
      createAbortSignal: () => new AbortController().signal,
      extractAskContentsFn,
      organizationId,
      orgAIConfig: null,
      promptCachingEnabled: false,
      refRegistry,
      safeDb: createSafeDb(),
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds: [workspaceId],
      }),
      userId,
    });
    const tool = tools[REVIEW_FOLDER_CONSISTENCY_TOOL_NAME];
    if (!tool) {
      throw new Error("review_folder_consistency must be registered");
    }
    const execute = tool.execute;
    if (!execute) {
      throw new Error("review_folder_consistency must be server-executed");
    }

    const output = await execute(
      { folderRef },
      asTestRaw<Parameters<typeof execute>[1]>({}),
    );

    expect(output.folder).toEqual({ folderRef, name: "Loan security" });
    expect(output.coverage).toEqual({
      complete: false,
      snapshotDocumentCount: 21,
      traversalDepthLimit: LIMITS.folderConsistencyTraversalDepthMax,
      additionalDescendantsMayExist: false,
    });
    expect(output.documentsReviewed).toHaveLength(20);
    expect(output.documentsSkipped).toEqual([]);
    expect(output.documentsNotChecked).toEqual([
      { documentRef: "ent_22", name: "Document 21" },
    ]);
    expect(output.documentsNotCheckedOmittedCount).toBe(0);
    expect(output.citations).toEqual([
      {
        type: "pdf-bates",
        documentName: "Document 1",
        documentRef: "ent_2",
        sourceHref: "#stella-source-ref=src_1",
        statement: "Principal is CZK 10,000,000.",
        bates: "F0-0002",
        pageNumber: 2,
      },
      {
        type: "docx-folio",
        documentName: "Document 2",
        documentRef: "ent_3",
        sourceHref: "#stella-source-ref=src_2",
        statement: "Guarantee is CZK 8,000,000.",
        passage: "Ručitel ručí do výše 8 000 000 Kč.",
        blockId: "A1B2C3D4",
      },
    ]);
  });

  test("does not register without an authorized matter", () => {
    expect(
      createFolderConsistencyReviewTools({
        createAbortSignal: () => new AbortController().signal,
        organizationId,
        orgAIConfig: null,
        promptCachingEnabled: false,
        refRegistry: createChatRefRegistry(),
        safeDb: createSafeDb(),
        toolWorkspaceIds: resolveToolWorkspaceIds({
          pinnedIds: [],
          accessibleWorkspaceIds: [],
        }),
        userId,
      }),
    ).toEqual({});
  });

  test("rejects a folder ref from a matter outside the authorized set", async () => {
    const refRegistry = createChatRefRegistry();
    const folderRef = refRegistry.toEntityRef({
      entityId: folderId,
      workspaceId: otherWorkspaceId,
    });
    const safeDb: SafeDb = async () => {
      throw new Error("authorization must fail before querying the folder");
    };
    const tools = createFolderConsistencyReviewTools({
      createAbortSignal: () => new AbortController().signal,
      organizationId,
      orgAIConfig: null,
      promptCachingEnabled: false,
      refRegistry,
      safeDb,
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds: [workspaceId],
      }),
      userId,
    });
    const tool = tools[REVIEW_FOLDER_CONSISTENCY_TOOL_NAME];
    const execute = tool?.execute;
    if (!execute) {
      throw new Error("review_folder_consistency must be server-executed");
    }

    const result = await Result.tryPromise(async () =>
      execute({ folderRef }, asTestRaw<Parameters<typeof execute>[1]>({})),
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      return;
    }
    expect(result.error).toMatchObject({ cause: { kind: "not-found" } });
  });
});
