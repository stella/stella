import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { pendingUploadS3KeysForDeletion } from "@/api/lib/pending-upload-keys";

describe("pendingUploadS3KeysForDeletion", () => {
  const organizationId = toSafeId<"organization">(
    "0198fa3d-fc8d-7000-8000-000000000001",
  );
  const workspaceId = toSafeId<"workspace">(
    "0198fa3d-fc8d-7000-8000-000000000002",
  );
  const id = toSafeId<"pendingUpload">("0198fa3d-fc8d-7000-8000-000000000003");

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
});
