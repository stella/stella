import { Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { env } from "@/api/env";
import { readEntityByIdHandler } from "@/api/handlers/entities/get";
import readFieldFile from "@/api/handlers/entities/read-field-file";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createScopedDbMock,
  createSelectQueryMock,
} from "@/api/tests/scoped-db-mock";

const testState = createTestState({ file: import.meta.path, config: env });

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
        stamp: null,
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

  for (const linked of [false, true]) {
    for (const deploymentEnabled of [false, true]) {
      for (const enrolled of [false, true]) {
        test(`retained entity visibility: linked=${String(linked)} flag=${String(deploymentEnabled)} grant=${String(enrolled)}`, async () => {
          const organizationId = toSafeId<"organization">("org_entity_access");
          const userId = toSafeId<"user">("reader_entity_access");
          const previous = env.FEATURE_FLOWS;
          const restore = setRuntimeModeForTesting({
            mode: RUNTIME_MODE.strict,
          });
          testState.setConfig("FEATURE_FLOWS", deploymentEnabled);
          try {
            const fieldRead = mock(async () => null);
            const { safeDb, scopedDb } = createScopedDbMock(
              {
                query: {
                  entities: { findFirst: findFirstMock },
                  fields: { findFirst: fieldRead },
                },
              },
              {
                flowTaskGates: linked
                  ? [
                      {
                        runId: toSafeId("run_1"),
                        status: "awaiting_review",
                        organizationId,
                      },
                    ]
                  : [],
                featureAccess: {
                  identity: {
                    email: "reader@example.test",
                    emailVerified: true,
                  },
                  enrolments: enrolled
                    ? [{ featureId: "flows", organizationId, userId }]
                    : [],
                },
              },
            );
            const result = await Result.gen(() =>
              readEntityByIdHandler({
                safeDb,
                userId,
                workspaceId: toSafeId("ws_1"),
                entityId: toSafeId("entity_1"),
              }),
            );
            const visible = !linked || (deploymentEnabled && enrolled);
            expect(result.isOk()).toBe(visible);
            expect(findFirstMock).toHaveBeenCalledTimes(visible ? 1 : 0);
            if (result.isErr()) {
              expect(result.error).toMatchObject({
                status: 404,
                message: "Not found",
              });
              const file = await readFieldFile.handler(
                asTestRaw<Parameters<typeof readFieldFile.handler>[0]>({
                  safeDb,
                  scopedDb,
                  memberRole: sessionMemberRole("owner"),
                  workspaceId: toSafeId("ws_1"),
                  user: { id: userId },
                  session: { activeOrganizationId: organizationId },
                  params: {
                    entityId: toSafeId("entity_1"),
                    fieldId: toSafeId("field_1"),
                  },
                  request: new Request(
                    "https://example.test/entities/field-file",
                  ),
                  route: "/entities/:entityId/field-file",
                }),
              );
              expect(file).toMatchObject({ code: 404 });
              expect(fieldRead).not.toHaveBeenCalled();
            }
          } finally {
            testState.setConfig("FEATURE_FLOWS", previous);
            restore();
          }
        });
      }
    }
  }

  test("loads extraction provenance with the bounded current fields", async () => {
    const { safeDb } = createScopedDbMock({
      select: () => createSelectQueryMock([]),
      query: { entities: { findFirst: findFirstMock } },
    });

    const result = await Result.gen(() =>
      readEntityByIdHandler({
        safeDb,
        workspaceId: toSafeId("ws_1"),
        entityId: toSafeId("entity_1"),
        userId: toSafeId("reader_1"),
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
        stamp: null,
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
      select: () => createSelectQueryMock([]),
      query: { entities: { findFirst: findFirstMock } },
    });

    const result = await Result.gen(() =>
      readEntityByIdHandler({
        safeDb,
        workspaceId: toSafeId("ws_1"),
        entityId: toSafeId("entity_1"),
        userId: toSafeId("reader_1"),
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
        stamp: null,
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
      select: () => createSelectQueryMock([]),
      query: { entities: { findFirst: findFirstMock } },
    });

    const result = await Result.gen(() =>
      readEntityByIdHandler({
        safeDb,
        workspaceId: toSafeId("ws_1"),
        entityId: toSafeId("entity_1"),
        userId: toSafeId("reader_1"),
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
        stamp: null,
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
      select: () => createSelectQueryMock([]),
      query: { entities: { findFirst: findFirstMock } },
    });

    const result = await Result.gen(() =>
      readEntityByIdHandler({
        safeDb,
        workspaceId: toSafeId("ws_1"),
        entityId: toSafeId("entity_1"),
        userId: toSafeId("reader_1"),
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
        stamp: null,
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
      select: () => createSelectQueryMock([]),
      query: { entities: { findFirst: findFirstMock } },
    });

    const result = await Result.gen(() =>
      readEntityByIdHandler({
        safeDb,
        workspaceId: toSafeId("ws_1"),
        entityId: toSafeId("entity_1"),
        userId: toSafeId("reader_1"),
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
