import { afterEach, describe, expect, test } from "bun:test";

import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";

afterEach(() => {
  useInspectorStore.setState({
    tabs: [],
    activeId: null,
    activationSeq: 0,
    pendingRenameTabId: null,
    minimized: false,
  });
});

describe("openChat", () => {
  test("creates a workspace-scoped tab when workspaceId is provided", () => {
    useInspectorStore.getState().openChat({
      id: "thread-A",
      workspaceId: "ws-1",
      contextMatterIds: ["ws-1"],
    });

    const tab = useInspectorStore
      .getState()
      .tabs.find((t) => t.id === "thread-A");
    expect(tab?.type).toBe("chat");
    if (tab?.type !== "chat") {
      throw new Error("expected chat tab");
    }
    expect(tab.workspaceId).toBe("ws-1");
    expect(tab.contextMatterIds).toEqual(["ws-1"]);
  });

  test("creates a global tab when workspaceId is omitted", () => {
    useInspectorStore.getState().openChat({ id: "thread-B" });

    const tab = useInspectorStore
      .getState()
      .tabs.find((t) => t.id === "thread-B");
    expect(tab?.type).toBe("chat");
    if (tab?.type !== "chat") {
      throw new Error("expected chat tab");
    }
    expect(tab.workspaceId).toBeUndefined();
    expect(tab.contextMatterIds).toEqual([]);
  });

  test("re-opening an existing tab updates workspaceId only when supplied", () => {
    useInspectorStore.getState().openChat({
      id: "thread-C",
      workspaceId: "ws-1",
    });
    useInspectorStore.getState().openChat({
      id: "thread-C",
      contextMatterIds: ["ws-2"],
    });

    const tab = useInspectorStore
      .getState()
      .tabs.find((t) => t.id === "thread-C");
    if (tab?.type !== "chat") {
      throw new Error("expected chat tab");
    }
    // workspaceId stays — re-opening without it must not silently
    // re-scope the thread; that's a separate move action.
    expect(tab.workspaceId).toBe("ws-1");
    expect(tab.contextMatterIds).toEqual(["ws-2"]);
  });
});

describe("replacePdfFieldId", () => {
  test("re-opening an existing pdf tab refreshes the file label", () => {
    useInspectorStore.getState().openPdf({
      id: "field-1",
      entityId: "entity-1",
      label: "Document 4",
      mimeType: "application/pdf",
      pdfFileId: "pdf-1",
      propertyId: "property-1",
      workspaceId: "workspace-1",
    });

    useInspectorStore.getState().openPdf({
      id: "field-1",
      entityId: "entity-1",
      label: "0041_Pleadings_draft.pdf",
      mimeType: "application/pdf",
      pdfFileId: "pdf-1",
      propertyId: "property-1",
      workspaceId: "workspace-1",
    });

    const tab = useInspectorStore
      .getState()
      .tabs.find((item) => item.id === "field-1");
    if (tab?.type !== "pdf") {
      throw new Error("expected pdf tab");
    }

    expect(tab.label).toBe("0041_Pleadings_draft.pdf");
  });

  test("preserves the pdf tab render id across version replacement", () => {
    useInspectorStore.getState().openPdf({
      id: "field-old",
      entityId: "entity-1",
      label: "Contract.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      pdfFileId: null,
      propertyId: "property-1",
      workspaceId: "workspace-1",
    });

    const before = useInspectorStore
      .getState()
      .tabs.find((tab) => tab.id === "field-old");
    if (before?.type !== "pdf") {
      throw new Error("expected pdf tab");
    }

    useInspectorStore.getState().replacePdfFieldId("field-old", "field-new");

    const after = useInspectorStore
      .getState()
      .tabs.find((tab) => tab.id === "field-new");
    if (after?.type !== "pdf") {
      throw new Error("expected pdf tab");
    }

    expect(after.renderId).toBe(before.renderId);
    expect(useInspectorStore.getState().activeId).toBe("field-new");
  });
});
