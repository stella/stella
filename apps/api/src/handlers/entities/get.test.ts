import { Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { readEntityByIdHandler } from "@/api/handlers/entities/get";
import { toSafeId } from "@/api/lib/branded-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const findFirstMock = mock();

describe("readEntityByIdHandler", () => {
  beforeEach(() => {
    findFirstMock.mockReset();
    findFirstMock.mockResolvedValue({
      kind: "document",
      name: "Share Purchase Agreement",
      extractedContent: null,
      currentVersion: {
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        id: "entity_version_1",
        fields: [
          {
            id: "field_1",
            propertyId: "property_1",
            content: { type: "file" },
          },
        ],
      },
      versions: [{ id: "entity_version_1" }],
    });
  });

  test("loads extraction provenance with the bounded current fields", async () => {
    const { safeDb } = createScopedDbMock({
      query: { entities: { findFirst: findFirstMock } },
    });

    const result = await Result.gen(() =>
      readEntityByIdHandler({
        safeDb,
        workspaceId: toSafeId("ws_1"),
        entityId: toSafeId("entity_1"),
      }),
    );

    expect(Result.isOk(result)).toBe(true);
    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        with: expect.objectContaining({
          extractedContent: {
            columns: {
              extractedAt: true,
              sourceEntityVersionId: true,
              sourceFieldId: true,
              sourceFileId: true,
              sourceSha256Hex: true,
            },
          },
          currentVersion: expect.objectContaining({
            with: expect.objectContaining({
              fields: expect.objectContaining({
                orderBy: { id: "asc" },
              }),
            }),
          }),
          versions: {
            columns: { id: true },
            limit: 1,
            orderBy: { id: "desc", versionNumber: "desc" },
          },
        }),
      }),
    );
  });

  test("returns the persisted field used as the entity extraction source", async () => {
    findFirstMock.mockResolvedValue({
      kind: "document",
      name: "Share Purchase Agreement",
      extractedContent: {
        extractedAt: new Date("2026-01-03T00:00:00.000Z"),
        sourceEntityVersionId: "entity_version_1",
        sourceFieldId: "field_sibling",
        sourceFileId: "file_sibling",
        sourceSha256Hex: "b".repeat(64),
      },
      currentVersion: {
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        id: "entity_version_1",
        fields: [
          {
            id: "field_text",
            propertyId: "property_text",
            content: { type: "text", value: "Reference" },
          },
          {
            id: "field_email",
            propertyId: "property_email",
            content: {
              type: "file",
              id: "file_email",
              sha256Hex: "a".repeat(64),
            },
          },
          {
            id: "field_sibling",
            propertyId: "property_sibling",
            content: {
              type: "file",
              id: "file_sibling",
              sha256Hex: "b".repeat(64),
            },
          },
        ],
      },
      versions: [{ id: "entity_version_1" }],
    });
    const { safeDb } = createScopedDbMock({
      query: { entities: { findFirst: findFirstMock } },
    });

    const result = await Result.gen(() =>
      readEntityByIdHandler({
        safeDb,
        workspaceId: toSafeId("ws_1"),
        entityId: toSafeId("entity_1"),
      }),
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.extractionFileFieldId).toBe(
        toSafeId<"field">("field_sibling"),
      );
      expect(result.value.processingFileFieldId).toBe(
        toSafeId<"field">("field_sibling"),
      );
    }
  });

  test("keeps stale extraction unavailable while returning one live processing file", async () => {
    findFirstMock.mockResolvedValue({
      kind: "document",
      name: "Replacement Agreement",
      extractedContent: {
        extractedAt: new Date("2026-01-01T00:00:00.000Z"),
        sourceEntityVersionId: "entity_version_old",
        sourceFieldId: "field_old",
        sourceFileId: "file_old",
        sourceSha256Hex: "a".repeat(64),
      },
      currentVersion: {
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        id: "entity_version_1",
        fields: [
          {
            id: "field_current",
            propertyId: "property_current",
            content: {
              type: "file",
              id: "file_current",
              sha256Hex: "b".repeat(64),
            },
          },
        ],
      },
      versions: [{ id: "entity_version_1" }],
    });
    const { safeDb } = createScopedDbMock({
      query: { entities: { findFirst: findFirstMock } },
    });

    const result = await Result.gen(() =>
      readEntityByIdHandler({
        safeDb,
        workspaceId: toSafeId("ws_1"),
        entityId: toSafeId("entity_1"),
      }),
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.extractionFileFieldId).toBeNull();
      expect(result.value.processingFileFieldId).toBe(
        toSafeId<"field">("field_current"),
      );
    }
  });

  test("does not advertise stale legacy extraction after file replacement", async () => {
    findFirstMock.mockResolvedValue({
      kind: "document",
      name: "Replacement Email",
      extractedContent: {
        extractedAt: new Date("2026-01-01T00:00:00.000Z"),
        sourceEntityVersionId: null,
        sourceFieldId: null,
        sourceFileId: null,
        sourceSha256Hex: null,
      },
      currentVersion: {
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        id: "entity_version_2",
        fields: [
          {
            id: "field_replacement",
            propertyId: "property_current",
            content: {
              type: "file",
              id: "file_replacement",
              sha256Hex: "b".repeat(64),
            },
          },
        ],
      },
      versions: [{ id: "entity_version_2" }],
    });
    const { safeDb } = createScopedDbMock({
      query: { entities: { findFirst: findFirstMock } },
    });

    const result = await Result.gen(() =>
      readEntityByIdHandler({
        safeDb,
        workspaceId: toSafeId("ws_1"),
        entityId: toSafeId("entity_1"),
      }),
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.extractionFileFieldId).toBeNull();
      expect(result.value.processingFileFieldId).toBe(
        toSafeId<"field">("field_replacement"),
      );
    }
  });

  test("keeps missing extraction unavailable and ignores JSON-null fields", async () => {
    findFirstMock.mockResolvedValue({
      kind: "document",
      name: "Pending Email",
      extractedContent: null,
      currentVersion: {
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        id: "entity_version_1",
        fields: [
          {
            id: "field_null",
            propertyId: "property_null",
            content: null,
          },
          {
            id: "field_email",
            propertyId: "property_email",
            content: {
              type: "file",
              id: "file_email",
              sha256Hex: "a".repeat(64),
            },
          },
        ],
      },
      versions: [{ id: "entity_version_1" }],
    });
    const { safeDb } = createScopedDbMock({
      query: { entities: { findFirst: findFirstMock } },
    });

    const result = await Result.gen(() =>
      readEntityByIdHandler({
        safeDb,
        workspaceId: toSafeId("ws_1"),
        entityId: toSafeId("entity_1"),
      }),
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.extractionFileFieldId).toBeNull();
      expect(result.value.processingFileFieldId).toBe(
        toSafeId<"field">("field_email"),
      );
    }
  });
});
