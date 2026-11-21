import { describe, expect, it } from "bun:test";

import type { FileTab } from "@/components/inspector/file-tab";
import type { GenericTab } from "@/components/inspector/inspector-store-types";

import { resolveInspectorMatterColor } from "./inspector-tab-workspace";

const BORROWED_GREEN = "#10b981";

const statuteTab: GenericTab = {
  type: "view",
  viewType: "statute",
  id: "statute-99-1963",
  label: "Act 99/1963",
  payload: null,
};

const fileTab: FileTab = {
  type: "pdf",
  id: "file-a",
  entityId: "entity-a",
  label: "Side letter.pdf",
  fileName: "Side letter.pdf",
  pdfFileId: null,
  workspaceId: "matter-a",
};

describe("resolveInspectorMatterColor", () => {
  it("keeps a matter-free tab as plain as a matter-free route", () => {
    expect(
      resolveInspectorMatterColor({
        activeTab: statuteTab,
        routeMatterColor: null,
        workspaceMatterColor: BORROWED_GREEN,
      }),
    ).toBeNull();
  });

  it("paints a matter-free tab with the route's matter", () => {
    expect(
      resolveInspectorMatterColor({
        activeTab: statuteTab,
        routeMatterColor: "#f59e0b",
        workspaceMatterColor: BORROWED_GREEN,
      }),
    ).toBe("#f59e0b");
  });

  it("keeps a matter tab's own tint beside a matter-free route", () => {
    expect(
      resolveInspectorMatterColor({
        activeTab: fileTab,
        routeMatterColor: null,
        workspaceMatterColor: BORROWED_GREEN,
      }),
    ).toBe(BORROWED_GREEN);
  });

  it("falls back to the resolved matter when the host gives no route colour", () => {
    expect(
      resolveInspectorMatterColor({
        activeTab: statuteTab,
        routeMatterColor: undefined,
        workspaceMatterColor: BORROWED_GREEN,
      }),
    ).toBe(BORROWED_GREEN);
  });
});
