import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { toSafeId, type SafeId } from "@/api/lib/branded-types";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  COMPARE_VERSIONS_TOOL_NAME,
  createVersionCompareTools,
} from "./version-compare-tools";

const organizationId = toSafeId<"organization">(
  "11111111-1111-4111-8111-111111111111",
);
const workspaceId = toSafeId<"workspace">(
  "22222222-2222-4222-8222-222222222222",
);
const entityId = toSafeId<"entity">("55555555-5555-4555-8555-555555555555");
const otherEntityId = toSafeId<"entity">(
  "66666666-6666-4666-8666-666666666666",
);
const activeFileFieldId = toSafeId<"field">(
  "77777777-7777-4777-8777-777777777777",
);
const activeFilePropertyId = toSafeId<"property">(
  "88888888-8888-4888-8888-888888888888",
);
const otherFilePropertyId = toSafeId<"property">(
  "99999999-9999-4999-8999-999999999999",
);
const baseVersionId = "33333333-3333-4333-8333-333333333333";
const revisedVersionId = "44444444-4444-4444-8444-444444444444";

const toolWorkspaceIds = resolveToolWorkspaceIds({
  pinnedIds: [],
  accessibleWorkspaceIds: [workspaceId],
});

const activeFileContext = {
  entityId,
  fileFieldId: activeFileFieldId,
} as const;

const createMockDocxFieldContent = (id: string) =>
  ({
    version: 1,
    type: "file",
    id,
    fileName: "document.docx",
    mimeType: DOCX_MIME_TYPE,
    sizeBytes: 1,
    encrypted: true,
    sha256Hex:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    pdfFileId: null,
  }) as const;

const mockDocxFieldContent = createMockDocxFieldContent(
  "77777777-7777-4777-8777-777777777777",
);

type MockVersion = {
  entityId: SafeId<"entity">;
  workspaceId: typeof workspaceId;
};

type MockField = {
  content: typeof mockDocxFieldContent;
  propertyId: SafeId<"property">;
};

// A `tx.query.*` seam that answers `entityVersions.findFirst` from a fixed
// map (undefined = the workspace-scoped lookup found nothing) and provides a
// DOCX active-file property field when a version does resolve.
const createSafeDb = (
  versionsById: Record<string, MockVersion | undefined>,
  {
    fieldsByVersionId = {},
  }: {
    fieldsByVersionId?: Record<string, MockField[] | undefined>;
  } = {},
): SafeDb => {
  const defaultFields = [
    { content: mockDocxFieldContent, propertyId: activeFilePropertyId },
  ];
  const tx = {
    query: {
      entityVersions: {
        findFirst: async ({ where }: { where: { id: { eq: string } } }) =>
          versionsById[where.id.eq],
      },
      fields: {
        findFirst: async ({
          where,
        }: {
          where:
            | { id: { eq: string } }
            | {
                entityVersionId: { eq: string };
                propertyId: { eq: SafeId<"property"> };
              };
        }) => {
          if ("id" in where) {
            if (where.id.eq !== activeFileFieldId) {
              return undefined;
            }
            return {
              content: mockDocxFieldContent,
              propertyId: activeFilePropertyId,
              entityVersion: { entityId },
            };
          }

          const versionFields =
            fieldsByVersionId[where.entityVersionId.eq] ?? defaultFields;
          return versionFields.find(
            (field) => field.propertyId === where.propertyId.eq,
          );
        },
      },
    },
  };
  return async (callback) =>
    // oxlint-disable-next-line node/callback-return -- result must be wrapped in Result.ok, not returned raw
    Result.ok(await callback(asTestRaw<Transaction>(tx)));
};

const getExecute = (safeDb: SafeDb) => {
  const tools = createVersionCompareTools({
    safeDb,
    organizationId,
    activeFileContext,
    toolWorkspaceIds,
  });
  const tool = tools[COMPARE_VERSIONS_TOOL_NAME];
  const execute = tool.execute;
  if (!execute) {
    throw new Error("compare_versions must be server-executed");
  }
  return execute;
};

describe("createVersionCompareTools", () => {
  test("registers a single server-executed compare_versions tool", () => {
    const tools = createVersionCompareTools({
      safeDb: createSafeDb({}),
      organizationId,
      activeFileContext,
      toolWorkspaceIds,
    });
    expect(Object.keys(tools)).toEqual([COMPARE_VERSIONS_TOOL_NAME]);
    expect(tools[COMPARE_VERSIONS_TOOL_NAME].needsApproval).toBeUndefined();
    expect(tools[COMPARE_VERSIONS_TOOL_NAME].execute).toBeDefined();
  });

  const runAndCaptureMessage = async (
    execute: ReturnType<typeof getExecute>,
  ) => {
    try {
      await execute(
        { baseVersionId, revisedVersionId },
        asTestRaw<Parameters<typeof execute>[1]>({}),
      );
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("Expected compare_versions to reject");
  };

  test("rejects a base version outside the caller's authorized workspaces", async () => {
    // The base id resolves to nothing (not in an accessible workspace); the
    // revised id would resolve, but access must fail closed on the base.
    const message = await runAndCaptureMessage(
      getExecute(
        createSafeDb({
          [baseVersionId]: undefined,
          [revisedVersionId]: { entityId, workspaceId },
        }),
      ),
    );
    expect(message).toMatch(/base version was not found in your workspaces/iu);
  });

  test("rejects a revised version outside the caller's authorized workspaces", async () => {
    const message = await runAndCaptureMessage(
      getExecute(
        createSafeDb({
          [baseVersionId]: { entityId, workspaceId },
          [revisedVersionId]: undefined,
        }),
      ),
    );
    expect(message).toMatch(
      /revised version was not found in your workspaces/iu,
    );
  });

  test("rejects versions from different documents", async () => {
    const message = await runAndCaptureMessage(
      getExecute(
        createSafeDb({
          [baseVersionId]: { entityId, workspaceId },
          [revisedVersionId]: { entityId: otherEntityId, workspaceId },
        }),
      ),
    );
    expect(message).toMatch(/different documents/iu);
  });

  test("rejects versions outside the active document", async () => {
    const message = await runAndCaptureMessage(
      getExecute(
        createSafeDb({
          [baseVersionId]: { entityId: otherEntityId, workspaceId },
          [revisedVersionId]: { entityId: otherEntityId, workspaceId },
        }),
      ),
    );
    expect(message).toMatch(/must belong to the active document/iu);
  });

  test("requires the active file property in both compared versions", async () => {
    const message = await runAndCaptureMessage(
      getExecute(
        createSafeDb(
          {
            [baseVersionId]: { entityId, workspaceId },
            [revisedVersionId]: { entityId, workspaceId },
          },
          {
            fieldsByVersionId: {
              [baseVersionId]: [
                {
                  content: createMockDocxFieldContent(
                    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                  ),
                  propertyId: otherFilePropertyId,
                },
                {
                  content: createMockDocxFieldContent(
                    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                  ),
                  propertyId: activeFilePropertyId,
                },
              ],
              [revisedVersionId]: [
                {
                  content: createMockDocxFieldContent(
                    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                  ),
                  propertyId: otherFilePropertyId,
                },
              ],
            },
          },
        ),
      ),
    );
    expect(message).toMatch(
      /revised version does not contain the active DOCX file/iu,
    );
  });
});
