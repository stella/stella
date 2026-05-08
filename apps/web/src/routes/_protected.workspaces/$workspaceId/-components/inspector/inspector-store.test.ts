import { afterEach, describe, expect, test } from "bun:test";

import { toChatThreadId } from "@/lib/chat-thread-ref";
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
    const threadId = toChatThreadId("thread-A");
    useInspectorStore.getState().openChat({
      id: threadId,
      workspaceId: "ws-1",
      contextMatterIds: ["ws-1"],
    });

    const tab = useInspectorStore
      .getState()
      .tabs.find((t) => t.id === threadId);
    expect(tab?.type).toBe("chat");
    if (tab?.type !== "chat") {
      throw new Error("expected chat tab");
    }
    expect(tab.workspaceId).toBe("ws-1");
    expect(tab.contextMatterIds).toEqual(["ws-1"]);
  });

  test("creates a global tab when workspaceId is omitted", () => {
    const threadId = toChatThreadId("thread-B");
    useInspectorStore.getState().openChat({ id: threadId });

    const tab = useInspectorStore
      .getState()
      .tabs.find((t) => t.id === threadId);
    expect(tab?.type).toBe("chat");
    if (tab?.type !== "chat") {
      throw new Error("expected chat tab");
    }
    expect(tab.workspaceId).toBeUndefined();
    expect(tab.contextMatterIds).toEqual([]);
  });

  test("re-opening an existing tab updates workspaceId only when supplied", () => {
    const threadId = toChatThreadId("thread-C");
    useInspectorStore.getState().openChat({
      id: threadId,
      workspaceId: "ws-1",
    });
    useInspectorStore.getState().openChat({
      id: threadId,
      contextMatterIds: ["ws-2"],
    });

    const tab = useInspectorStore
      .getState()
      .tabs.find((t) => t.id === threadId);
    if (tab?.type !== "chat") {
      throw new Error("expected chat tab");
    }
    // workspaceId stays — re-opening without it must not silently
    // re-scope the thread; that's a separate move action.
    expect(tab.workspaceId).toBe("ws-1");
    expect(tab.contextMatterIds).toEqual(["ws-2"]);
  });
});

describe("openExternal", () => {
  test("preserves the source connector icon on the external tab", () => {
    useInspectorStore.getState().openExternal({
      connectorSlug: "salvia",
      iconHref: "https://salvia.example/favicon.ico",
      label: "Decision",
      url: "https://example.test/decision",
    });

    useInspectorStore.getState().openExternal({
      label: "Decision",
      url: "https://example.test/decision",
    });

    const tab = useInspectorStore
      .getState()
      .tabs.find(
        (item) => item.id === "external:https://example.test/decision",
      );
    if (tab?.type !== "external") {
      throw new Error("expected external tab");
    }

    expect(tab.connectorSlug).toBe("salvia");
    expect(tab.iconHref).toBe("https://salvia.example/favicon.ico");
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

  test("openPdf with a different fieldId for the same entity keeps a single tab", () => {
    useInspectorStore.getState().openPdf({
      id: "field-v1",
      entityId: "entity-1",
      label: "Contract.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      pdfFileId: null,
      propertyId: "property-1",
      workspaceId: "workspace-1",
    });

    useInspectorStore.getState().openPdf({
      id: "field-v2",
      entityId: "entity-1",
      label: "Contract.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      pdfFileId: null,
      propertyId: "property-1",
      workspaceId: "workspace-1",
    });

    const pdfTabs = useInspectorStore
      .getState()
      .tabs.filter((t) => t.type === "pdf");
    expect(pdfTabs).toHaveLength(1);
    expect(pdfTabs[0]?.id).toBe("field-v2");
    expect(useInspectorStore.getState().activeId).toBe("field-v2");
  });

  test("openPdfForEntity drops a stale tab whose id collides with the new field", () => {
    useInspectorStore.getState().openPdf({
      id: "field-shared",
      entityId: "entity-A",
      label: "A.docx",
      mimeType: "application/pdf",
      pdfFileId: null,
      propertyId: "property-A",
      workspaceId: "workspace-1",
    });

    useInspectorStore.getState().openPdfForEntity({
      id: "field-shared",
      entityId: "entity-B",
      label: "B.docx",
      mimeType: "application/pdf",
      pdfFileId: null,
      propertyId: "property-B",
      workspaceId: "workspace-1",
    });

    const pdfTabs = useInspectorStore
      .getState()
      .tabs.filter((t) => t.type === "pdf");
    expect(pdfTabs).toHaveLength(1);
    expect(pdfTabs[0]?.entityId).toBe("entity-B");
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
