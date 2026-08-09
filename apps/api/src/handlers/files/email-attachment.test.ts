import { Result } from "better-result";
import { expect, mock, test } from "bun:test";

import saveEmailAttachmentEndpoint from "@/api/handlers/files/email-attachment-save";
import { scanEmailAttachmentForSave } from "@/api/handlers/files/email-attachment-save-scan";
import { toSafeId } from "@/api/lib/branded-types";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type SaveEmailAttachmentContext = Parameters<
  typeof saveEmailAttachmentEndpoint.handler
>[0];

test("rejects an inaccessible target matter before reading source bytes", async () => {
  const sourceWorkspaceId = toSafeId<"workspace">("workspace_source");
  const destinationWorkspaceId = toSafeId<"workspace">(
    "workspace_inaccessible",
  );
  const scopedDb = mock(() => {
    throw new Error("source database must not be read");
  });
  const context = createTestHandlerContext<SaveEmailAttachmentContext>({
    body: { destinationWorkspaceId, parentId: null },
    getWorkspaceAccess: async () => null,
    params: {
      attachmentId: "ea1.invalid",
      fieldId: toSafeId<"field">("field_source"),
      workspaceId: sourceWorkspaceId,
    },
    scopedDb: asTestRaw(scopedDb),
    workspaceId: sourceWorkspaceId,
  });

  const result = await saveEmailAttachmentEndpoint.handler(context);

  expect(result).toEqual({
    code: 404,
    response: { message: "Target matter not found" },
  });
  expect(scopedDb).not.toHaveBeenCalled();
});

test("rejects extracted attachment bytes that fail the file scan", async () => {
  const result = await scanEmailAttachmentForSave({
    bytes: new TextEncoder().encode("not a PDF"),
    fileName: "evidence.pdf",
    mimeType: "application/pdf",
  });

  expect(Result.isError(result)).toBe(true);
  if (Result.isOk(result)) {
    return;
  }
  expect(result.error.status).toBe(422);
  expect(result.error.message).toStartWith("File rejected:");
});
