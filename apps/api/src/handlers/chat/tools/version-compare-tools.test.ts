import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { SafeDb, Transaction } from "@/api/db";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { toSafeId } from "@/api/lib/branded-types";
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
const baseVersionId = "33333333-3333-4333-8333-333333333333";
const revisedVersionId = "44444444-4444-4444-8444-444444444444";

const toolWorkspaceIds = resolveToolWorkspaceIds({
  pinnedIds: [],
  accessibleWorkspaceIds: [workspaceId],
});

const mockDocxFieldContent = {
  version: 1,
  type: "file",
  id: "77777777-7777-4777-8777-777777777777",
  fileName: "document.docx",
  mimeType: DOCX_MIME_TYPE,
  sizeBytes: 1,
  encrypted: true,
  sha256Hex: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  pdfFileId: null,
} as const;

// A `tx.query.*` seam that answers `entityVersions.findFirst` from a fixed
// map (undefined = the workspace-scoped lookup found nothing) and provides a
// DOCX file field when a version does resolve.
const createSafeDb = (
  versionsById: Record<
    string,
    { entityId: typeof entityId; workspaceId: typeof workspaceId } | undefined
  >,
): SafeDb => {
  const tx = {
    query: {
      entityVersions: {
        findFirst: async ({ where }: { where: { id: { eq: string } } }) =>
          versionsById[where.id.eq],
      },
      fields: {
        findMany: async () => [{ content: mockDocxFieldContent }],
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
});
