import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import { deletePendingUploads } from "@/api/lib/account-deletion-steps";
import { toSafeId } from "@/api/lib/branded-types";
import { pendingUploadS3KeysForDeletion } from "@/api/lib/pending-upload-keys";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

describe("pendingUploadS3KeysForDeletion", () => {
  const organizationId = toSafeId<"organization">(
    "0198fa3d-fc8d-7000-8000-000000000001",
  );
  const workspaceId = toSafeId<"workspace">(
    "0198fa3d-fc8d-7000-8000-000000000002",
  );
  const id = toSafeId<"pendingUpload">("0198fa3d-fc8d-7000-8000-000000000003");
  const normalUploadId = toSafeId<"pendingUpload">(
    "0198fa3d-fc8d-7000-8000-000000000006",
  );

  test("includes the reserved final object for an abandoned buffer intent", () => {
    expect(
      pendingUploadS3KeysForDeletion({
        declaredMime:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        id,
        organizationId,
        purpose: "entity_version",
        purposeData: {
          type: "entity_version",
          entityId: toSafeId<"entity">("0198fa3d-fc8d-7000-8000-000000000004"),
          reservedFileId: "0198fa3d-fc8d-7000-8000-000000000005",
        },
        workspaceId,
      }),
    ).toContain(
      `${organizationId}/${workspaceId}/0198fa3d-fc8d-7000-8000-000000000005.docx`,
    );
  });

  test("does not invent a final key for ordinary presigned uploads", () => {
    expect(
      pendingUploadS3KeysForDeletion({
        declaredMime: "application/zip",
        id,
        organizationId,
        purpose: "agent_skill",
        purposeData: { type: "agent_skill", scope: "private" },
        workspaceId,
      }),
    ).not.toContainEqual(expect.stringContaining(".zip"));
  });

  test("locks active intents before queuing their object keys", async () => {
    const lockStrengths: string[] = [];
    const deletedUserIds: unknown[] = [];
    const insertedCleanupValues: unknown[] = [];
    const updateValues: unknown[] = [];
    const tx = asTestRaw<Transaction>({
      select: () => ({
        from: () => ({
          where: () => ({
            for: async (strength: string) => {
              lockStrengths.push(strength);
              return [
                {
                  declaredMime:
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                  id,
                  organizationId,
                  purpose: "entity_version",
                  purposeData: {
                    type: "entity_version",
                    entityId: toSafeId<"entity">(
                      "0198fa3d-fc8d-7000-8000-000000000004",
                    ),
                    reservedFileId: "0198fa3d-fc8d-7000-8000-000000000005",
                  },
                  status: "scanning",
                  workspaceId,
                },
                {
                  declaredMime: "application/zip",
                  id: normalUploadId,
                  organizationId,
                  purpose: "agent_skill",
                  purposeData: { type: "agent_skill", scope: "private" },
                  status: "pending",
                  workspaceId,
                },
              ];
            },
          }),
        }),
      }),
      insert: () => ({
        values: (values: unknown[]) => ({
          onConflictDoNothing: async () => {
            insertedCleanupValues.push(...values);
          },
        }),
      }),
      update: () => ({
        set: (values: unknown) => {
          updateValues.push(values);
          return { where: async () => undefined };
        },
      }),
      delete: () => ({
        where: async (condition: unknown) => {
          deletedUserIds.push(condition);
        },
      }),
    });
    const s3KeysToDelete: string[] = [];

    await deletePendingUploads({
      tx,
      currentUserId: "user-1",
      s3KeysToDelete,
    });

    expect(lockStrengths).toEqual(["update"]);
    expect(deletedUserIds).toHaveLength(1);
    expect(updateValues).toEqual([
      expect.objectContaining({
        claimedByRequestId: null,
        status: "failed",
      }),
    ]);
    expect(insertedCleanupValues).toEqual([
      expect.objectContaining({
        id,
        organizationId,
        workspaceId,
        objectKey: `${organizationId}/${workspaceId}/0198fa3d-fc8d-7000-8000-000000000005.docx`,
      }),
    ]);
    expect(s3KeysToDelete).toContain(
      `${organizationId}/${workspaceId}/0198fa3d-fc8d-7000-8000-000000000005.docx`,
    );
    expect(s3KeysToDelete).toEqual(
      expect.arrayContaining(
        pendingUploadS3KeysForDeletion({
          declaredMime: "application/zip",
          id: normalUploadId,
          organizationId,
          purpose: "agent_skill",
          purposeData: { type: "agent_skill", scope: "private" },
          workspaceId,
        }),
      ),
    );
  });
});
