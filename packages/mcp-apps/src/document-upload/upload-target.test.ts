import { describe, expect, mock, test } from "bun:test";

import type { UploadTarget } from "./upload-target";
import { createUploadTargetController } from "./upload-target";

describe("document upload target lifecycle", () => {
  test("a new tool input invalidates the prior target until its result arrives", () => {
    const setLabel = mock((_label: string) => undefined);
    const setTarget = mock((_target: UploadTarget | null) => undefined);
    const controller = createUploadTargetController({
      formatLabel: (id) => `Document ${id}`,
      setLabel,
      setTarget,
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
    expect(setTarget).toHaveBeenLastCalledWith(controller.snapshot());

    controller.handleToolInput("new-document");
    expect(controller.snapshot()).toBeUndefined();
    expect(setLabel).toHaveBeenLastCalledWith("Document new-document");
    expect(setTarget).toHaveBeenLastCalledWith(null);

    controller.handleToolResult({
      entityId: "new-document",
      workspaceId: "new-workspace",
    });
    expect(setTarget).toHaveBeenLastCalledWith({
      entityId: "new-document",
      workspaceId: "new-workspace",
    });
  });

  test("an upload snapshot cannot be retargeted by a later tool result", () => {
    const controller = createUploadTargetController({
      formatLabel: (id) => `Document ${id}`,
      setLabel: () => undefined,
      setTarget: () => undefined,
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
    const setTarget = mock((_target: UploadTarget | null) => undefined);
    const controller = createUploadTargetController({
      formatLabel: (id) => `Document ${id}`,
      setLabel: () => undefined,
      setTarget,
    });

    controller.handleToolInput("first-document");
    controller.handleToolInput("second-document");
    controller.handleToolResult({
      entityId: "first-document",
      workspaceId: "first-workspace",
    });

    expect(controller.snapshot()).toBeUndefined();
    expect(setTarget).toHaveBeenLastCalledWith(null);

    controller.handleToolResult({
      entityId: "second-document",
      workspaceId: "second-workspace",
    });
    expect(controller.snapshot()).toEqual({
      entityId: "second-document",
      workspaceId: "second-workspace",
    });
    expect(setTarget).toHaveBeenLastCalledWith(controller.snapshot());
  });
});
