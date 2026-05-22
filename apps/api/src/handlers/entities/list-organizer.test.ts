import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import listFiles from "@/api/handlers/entities/list-files";
import listFolders from "@/api/handlers/entities/list-folders";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const workspaceId = toSafeId<"workspace">("ws_organizer_lists");
const organizationId = toSafeId<"organization">("org_organizer_lists");
const userId = toSafeId<"user">("user_organizer_lists");
const createdAt = new Date("2026-01-01T00:00:00.000Z");
const folder1 = toSafeId<"entity">("folder_1");
const folder2 = toSafeId<"entity">("folder_2");
const folder3 = toSafeId<"entity">("folder_3");
const entity1 = toSafeId<"entity">("entity_1");
const entity2 = toSafeId<"entity">("entity_2");

const createContext = ({
  query,
  rows,
}: {
  query: { limit?: number; cursor?: string };
  rows: unknown[];
}) => ({
  workspaceId,
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
  memberRole: { role: "owner" },
  query,
  safeDb: async <T>() => Result.ok(asTestRaw<T>(rows)),
  request: new Request("https://example.test/v1/entities/ws/files"),
  route: "/v1/entities/:workspaceId/files",
});

const createFoldersContext = (
  input: Parameters<typeof createContext>[0],
): Parameters<typeof listFolders.handler>[0] =>
  asTestRaw<Parameters<typeof listFolders.handler>[0]>(createContext(input));

const createFilesContext = (
  input: Parameters<typeof createContext>[0],
): Parameters<typeof listFiles.handler>[0] =>
  asTestRaw<Parameters<typeof listFiles.handler>[0]>(createContext(input));

describe("organizer entity lists", () => {
  test("folders return a cursor page without leaking cursor columns", async () => {
    const result = await listFolders.handler(
      createFoldersContext({
        query: { limit: 2 },
        rows: [
          { id: folder1, name: "Pleadings", parentId: null, createdAt },
          { id: folder2, name: "Evidence", parentId: null, createdAt },
          { id: folder3, name: "Drafts", parentId: null, createdAt },
        ],
      }),
    );

    expect("items" in result).toBe(true);
    if (!("items" in result)) {
      return;
    }

    expect(result.items).toEqual([
      { id: folder1, name: "Pleadings", parentId: null },
      { id: folder2, name: "Evidence", parentId: null },
    ]);
    expect(result.nextCursor).toEqual(expect.any(String));
    expect(result.limit).toBe(2);
  });

  test("files return a cursor page with only organizer fields", async () => {
    const result = await listFiles.handler(
      createFilesContext({
        query: { limit: 1 },
        rows: [
          {
            entityId: entity1,
            name: "Document",
            parentId: null,
            createdAt,
            fieldContent: {
              type: "file",
              version: 1,
              id: "file_1",
              fileName: "Document.pdf",
              mimeType: "application/pdf",
              sizeBytes: 42,
              encrypted: false,
              sha256Hex:
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              pdfFileId: null,
            },
          },
          {
            entityId: entity2,
            name: "Notes",
            parentId: null,
            createdAt,
            fieldContent: {
              type: "file",
              version: 1,
              id: "file_2",
              fileName: "Notes.pdf",
              mimeType: "application/pdf",
              sizeBytes: 42,
              encrypted: false,
              sha256Hex:
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              pdfFileId: null,
            },
          },
        ],
      }),
    );

    expect("items" in result).toBe(true);
    if (!("items" in result)) {
      return;
    }

    expect(result.items).toEqual([
      {
        entityId: entity1,
        name: "Document",
        parentId: null,
        fileName: "Document.pdf",
        mimeType: "application/pdf",
      },
    ]);
    expect(result.nextCursor).toEqual(expect.any(String));
    expect(result.limit).toBe(1);
  });
});
