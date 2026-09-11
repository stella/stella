import { describe, expect, test } from "bun:test";

import { planInspectorGroupTransfer } from "@/components/inspector/inspector-group-transfer.logic";

const chatTab = {
  type: "chat" as const,
  id: "00000000-0000-7000-8000-000000000001",
  label: "Research",
  contextMatterIds: ["matter-a"],
};

const fileTab = {
  type: "pdf" as const,
  id: "field-a",
  entityId: "entity-a",
  label: "Contract",
  fileName: "contract.pdf",
  pdfFileId: "pdf-a",
  workspaceId: "matter-a",
};

describe("Inspector matter-group transfer", () => {
  test("custom groups and ungrouping assign without confirmation", () => {
    expect(planInspectorGroupTransfer(chatTab, "custom:review")).toEqual({
      type: "assign",
    });
    expect(planInspectorGroupTransfer(fileTab, null)).toEqual({
      type: "assign",
    });
  });

  test("a chat asks before adding a new matter and preserves existing context", () => {
    expect(planInspectorGroupTransfer(chatTab, "matter:matter-b")).toEqual({
      type: "confirm-chat-context",
      workspaceId: "matter-b",
    });
    expect(planInspectorGroupTransfer(chatTab, "matter:matter-a")).toEqual({
      type: "assign",
    });
    expect(
      planInspectorGroupTransfer(
        { ...chatTab, contextMatterIds: [], workspaceId: "matter-b" },
        "matter:matter-b",
      ),
    ).toEqual({ type: "assign" });
  });

  test("a cross-matter file asks to copy while a file already there assigns", () => {
    expect(planInspectorGroupTransfer(fileTab, "matter:matter-b")).toEqual({
      type: "confirm-file-copy",
      workspaceId: "matter-b",
    });
    expect(planInspectorGroupTransfer(fileTab, "matter:matter-a")).toEqual({
      type: "assign",
    });
  });
});
