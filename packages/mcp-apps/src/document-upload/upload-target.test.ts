import { describe, expect, mock, test } from "bun:test";

import { createUploadTargetController } from "@/api/mcp/apps/document-upload/upload-target";

describe("document upload target lifecycle", () => {
  test("a new tool input invalidates the prior target until its result arrives", () => {
    let hasSelectedFile = true;
    const setLabel = mock((_label: string) => undefined);
    const setUploadEnabled = mock((_enabled: boolean) => undefined);
    const controller = createUploadTargetController({
      hasSelectedFile: () => hasSelectedFile,
      setLabel,
      setUploadEnabled,
    });

    controller.handleToolInput("old-document");
    controller.handleToolResult({
      entityId: "old-document",
      workspaceId: "old-workspace",
    });
    expect(controller.snapshot()).toEqual({
      entityId: "old-document",
      workspaceId: "old-workspace",
    });
    expect(setUploadEnabled).toHaveBeenLastCalledWith(true);

    controller.handleToolInput("new-document");
    expect(controller.snapshot()).toBeUndefined();
    expect(setLabel).toHaveBeenLastCalledWith("Document new-document");
    expect(setUploadEnabled).toHaveBeenLastCalledWith(false);

    hasSelectedFile = false;
    controller.handleToolResult({
      entityId: "new-document",
      workspaceId: "new-workspace",
    });
    expect(setUploadEnabled).toHaveBeenLastCalledWith(false);
  });

  test("an upload snapshot cannot be retargeted by a later tool result", () => {
    const controller = createUploadTargetController({
      hasSelectedFile: () => true,
      setLabel: () => undefined,
      setUploadEnabled: () => undefined,
    });
    controller.handleToolInput("first-document");
    controller.handleToolResult({
      entityId: "first-document",
      workspaceId: "first-workspace",
    });

    const uploadTarget = controller.snapshot();
    controller.handleToolInput("second-document");
    controller.handleToolResult({
      entityId: "second-document",
      workspaceId: "second-workspace",
    });

    expect(uploadTarget).toEqual({
      entityId: "first-document",
      workspaceId: "first-workspace",
    });
    expect(controller.snapshot()).toEqual({
      entityId: "second-document",
      workspaceId: "second-workspace",
    });
  });

  test("a late result for an older input cannot retarget the upload", () => {
    const setUploadEnabled = mock((_enabled: boolean) => undefined);
    const controller = createUploadTargetController({
      hasSelectedFile: () => true,
      setLabel: () => undefined,
      setUploadEnabled,
    });

    controller.handleToolInput("first-document");
    controller.handleToolInput("second-document");
    controller.handleToolResult({
      entityId: "first-document",
      workspaceId: "first-workspace",
    });

    expect(controller.snapshot()).toBeUndefined();
    expect(setUploadEnabled).toHaveBeenLastCalledWith(false);

    controller.handleToolResult({
      entityId: "second-document",
      workspaceId: "second-workspace",
    });
    expect(controller.snapshot()).toEqual({
      entityId: "second-document",
      workspaceId: "second-workspace",
    });
    expect(setUploadEnabled).toHaveBeenLastCalledWith(true);
  });
});
