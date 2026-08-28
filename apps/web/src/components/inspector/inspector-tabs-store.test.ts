import { afterEach, describe, expect, test } from "bun:test";

import { isFileFacet } from "@/components/inspector/inspector-broadcast";
import {
  buildSkillResourceTabId,
  closeInspectorTabsForEntities,
  getInspectorTabsBroadcastChannelName,
  initializeInspectorTabBroadcast,
  useInspectorTabsStore,
} from "@/components/inspector/inspector-tabs-store";
import { registerInspectorView } from "@/components/inspector/view-registry";
import { toChatThreadId } from "@/lib/chat-thread-ref";

let cleanupInspectorBroadcast: (() => void) | null = null;
let previousDateNow: (() => number) | undefined;
let previousWindowDescriptor: PropertyDescriptor | undefined;

afterEach(() => {
  cleanupInspectorBroadcast?.();
  cleanupInspectorBroadcast = null;
  if (previousDateNow !== undefined) {
    Date.now = previousDateNow;
    previousDateNow = undefined;
  }
  FakeBroadcastChannel.reset();
  if (previousWindowDescriptor) {
    Object.defineProperty(globalThis, "window", previousWindowDescriptor);
    previousWindowDescriptor = undefined;
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
  useInspectorTabsStore.setState({
    tabs: [],
    activeId: null,
    activationSeq: 0,
    flashTabId: null,
    flashSeq: 0,
    minimized: false,
    reviveSuggestion: null,
  });
});

class FakeBroadcastChannel {
  static readonly channels = new Map<string, Set<FakeBroadcastChannel>>();
  static postError: Error | null = null;

  readonly name: string;

  private readonly listeners = new Set<
    (event: MessageEvent<unknown>) => void
  >();

  constructor(name: string) {
    this.name = name;
    const peers = FakeBroadcastChannel.channels.get(name) ?? new Set();
    peers.add(this);
    FakeBroadcastChannel.channels.set(name, peers);
  }

  postMessage(message: unknown) {
    if (FakeBroadcastChannel.postError !== null) {
      throw FakeBroadcastChannel.postError;
    }
    this.dispatchToPeers(message);
  }

  emit(message: unknown) {
    this.dispatchToPeers(message);
  }

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ) {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ) {
    this.listeners.delete(listener);
  }

  private dispatchToPeers(message: unknown) {
    const peers = FakeBroadcastChannel.channels.get(this.name);
    if (!peers) {
      return;
    }

    for (const peer of peers) {
      if (peer === this) {
        continue;
      }
      peer.dispatch(message);
    }
  }

  private dispatch(message: unknown) {
    const event = new MessageEvent("message", {
      data: structuredClone(message),
    });
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  close() {
    const peers = FakeBroadcastChannel.channels.get(this.name);
    peers?.delete(this);
  }

  static reset() {
    FakeBroadcastChannel.channels.clear();
    FakeBroadcastChannel.postError = null;
  }
}

const installFakeBroadcastChannel = () => {
  previousWindowDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "window",
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { BroadcastChannel: FakeBroadcastChannel },
  });
};

const freezeDateNow = (updatedAt: number) => {
  previousDateNow = Date.now;
  Date.now = () => updatedAt;
};

describe("optimistic task creation", () => {
  test("opens a pending task immediately and resolves it in place", () => {
    useInspectorTabsStore.setState({ minimized: true });

    const pendingTaskId = useInspectorTabsStore
      .getState()
      .openPendingTask({ workspaceId: "workspace-1", label: "New task" });

    expect(useInspectorTabsStore.getState()).toMatchObject({
      activeId: pendingTaskId,
      minimized: false,
      tabs: [
        {
          type: "task",
          id: pendingTaskId,
          creationStatus: "pending",
          isNew: true,
          workspaceId: "workspace-1",
        },
      ],
    });

    useInspectorTabsStore
      .getState()
      .resolvePendingTask({ pendingTaskId, taskId: "task-1" });

    expect(useInspectorTabsStore.getState()).toMatchObject({
      activeId: "task-1",
      tabs: [
        {
          type: "task",
          id: "task-1",
          creationStatus: "ready",
          isNew: true,
          workspaceId: "workspace-1",
        },
      ],
    });
  });

  test("does not reopen a pending task the user closed", () => {
    const pendingTaskId = useInspectorTabsStore
      .getState()
      .openPendingTask({ workspaceId: "workspace-1" });
    useInspectorTabsStore.getState().closeTab(pendingTaskId);

    useInspectorTabsStore
      .getState()
      .resolvePendingTask({ pendingTaskId, taskId: "task-1" });

    expect(useInspectorTabsStore.getState().tabs).toEqual([]);
    expect(useInspectorTabsStore.getState().activeId).toBeNull();
  });
});

describe("openTabs", () => {
  const fileTarget = (suffix: string) =>
    ({
      type: "pdf",
      id: `field-${suffix}`,
      entityId: `entity-${suffix}`,
      label: `Document ${suffix}`,
      fileName: `Document ${suffix}.pdf`,
      mimeType: "application/pdf",
      pdfFileId: `pdf-${suffix}`,
      propertyId: "property-1",
      workspaceId: "workspace-1",
    }) as const;

  test("opens every target in order and focuses the one named, not the last", () => {
    useInspectorTabsStore.setState({ minimized: true });

    useInspectorTabsStore.getState().openTabs({
      targets: [fileTarget("a"), fileTarget("b"), fileTarget("c")],
      activeId: "field-b",
    });

    expect(useInspectorTabsStore.getState()).toMatchObject({
      activeId: "field-b",
      activationSeq: 1,
      minimized: false,
    });
    expect(useInspectorTabsStore.getState().tabs.map((tab) => tab.id)).toEqual([
      "field-a",
      "field-b",
      "field-c",
    ]);
  });

  test("opens a mixed selection of files and tasks", () => {
    useInspectorTabsStore.getState().openTabs({
      targets: [
        fileTarget("a"),
        {
          type: "task",
          id: "task-1",
          creationStatus: "ready",
          label: "Serve notice",
          isNew: false,
          workspaceId: "workspace-1",
        },
      ],
      activeId: "task-1",
    });

    expect(useInspectorTabsStore.getState()).toMatchObject({
      activeId: "task-1",
      tabs: [
        { type: "pdf", id: "field-a" },
        { type: "task", id: "task-1", creationStatus: "ready" },
      ],
    });
  });

  test("reuses an already-open tab and still honours the requested focus", () => {
    useInspectorTabsStore.getState().openFile(fileTarget("a"));

    useInspectorTabsStore.getState().openTabs({
      targets: [fileTarget("a"), fileTarget("b")],
      activeId: "field-a",
    });

    expect(useInspectorTabsStore.getState()).toMatchObject({
      activeId: "field-a",
      activationSeq: 2,
    });
    expect(useInspectorTabsStore.getState().tabs.map((tab) => tab.id)).toEqual([
      "field-a",
      "field-b",
    ]);
  });

  test("leaves the inspector untouched when nothing can be opened", () => {
    useInspectorTabsStore.setState({ minimized: true });

    useInspectorTabsStore.getState().openTabs({ targets: [], activeId: "" });

    expect(useInspectorTabsStore.getState()).toMatchObject({
      activeId: null,
      activationSeq: 0,
      minimized: true,
      tabs: [],
    });
  });

  test("rejects a focus target that is not being opened", () => {
    expect(() =>
      useInspectorTabsStore.getState().openTabs({
        targets: [fileTarget("a")],
        activeId: "field-b",
      }),
    ).toThrow("activeId outside its targets");
  });
});

describe("openChat", () => {
  test("creates a workspace-scoped tab when workspaceId is provided", () => {
    const threadId = toChatThreadId("thread-A");
    useInspectorTabsStore.getState().openChat({
      id: threadId,
      workspaceId: "ws-1",
      contextMatterIds: ["ws-1"],
    });

    const tab = useInspectorTabsStore
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
    useInspectorTabsStore.getState().openChat({ id: threadId });

    const tab = useInspectorTabsStore
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
    useInspectorTabsStore.getState().openChat({
      id: threadId,
      workspaceId: "ws-1",
    });
    useInspectorTabsStore.getState().openChat({
      id: threadId,
      contextMatterIds: ["ws-2"],
    });

    const tab = useInspectorTabsStore
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

  test("preserves active skill context on chat tabs", () => {
    const threadId = toChatThreadId("thread-skill");
    useInspectorTabsStore.getState().openChat({
      id: threadId,
      activeSkill: { skillId: "skill-1", skillName: "Review Skill" },
    });

    useInspectorTabsStore.getState().openChat({
      id: threadId,
      label: "Renamed skill chat",
    });

    const tab = useInspectorTabsStore
      .getState()
      .tabs.find((t) => t.id === threadId);
    if (tab?.type !== "chat") {
      throw new Error("expected chat tab");
    }

    expect(tab.activeSkill).toEqual({
      skillId: "skill-1",
      skillName: "Review Skill",
    });
    expect(tab.label).toBe("Renamed skill chat");
  });
});

describe("openExternal", () => {
  test("preserves the source connector icon on the external tab", () => {
    useInspectorTabsStore.getState().openExternal({
      connectorSlug: "salvia",
      iconHref: "https://salvia.example/favicon.ico",
      label: "Decision",
      url: "https://example.test/decision",
      workspaceId: "ws-origin",
    });

    useInspectorTabsStore.getState().openExternal({
      label: "Decision",
      url: "https://example.test/decision",
      workspaceId: "ws-origin",
    });

    const tab = useInspectorTabsStore
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

describe("openSkillResourceTab", () => {
  test("preserves edited content when reopening the same resource source", () => {
    const resource = {
      content: "Built-in content",
      label: "Guidance",
      mimeType: "text/markdown",
      origin: "built-in" as const,
      resourcePath: "knowledge/guidance.md",
      skillId: null,
      skillName: "review",
    };

    useInspectorTabsStore.getState().openSkillResourceTab(resource);
    useInspectorTabsStore
      .getState()
      .updateSkillResourceTabContent(
        buildSkillResourceTabId(resource),
        "Edited content",
      );
    useInspectorTabsStore.getState().openSkillResourceTab({
      ...resource,
      content: "Stale tool output",
    });

    const tab = useInspectorTabsStore
      .getState()
      .tabs.find((item) => item.id === buildSkillResourceTabId(resource));
    expect(tab).toMatchObject({
      type: "skill-resource",
      content: "Edited content",
    });
  });

  test("refreshes content when reopening a resource from a different source", () => {
    const resource = {
      content: "Built-in content",
      label: "Guidance",
      mimeType: "text/markdown",
      origin: "built-in" as const,
      resourcePath: "knowledge/guidance.md",
      skillId: null,
      skillName: "review",
    };

    useInspectorTabsStore.getState().openSkillResourceTab(resource);
    useInspectorTabsStore.getState().openSkillResourceTab({
      ...resource,
      content: "Installed content",
      origin: "upload",
      skillId: "agentSkill_1",
    });

    const tab = useInspectorTabsStore
      .getState()
      .tabs.find((item) => item.id === buildSkillResourceTabId(resource));
    expect(tab).toMatchObject({
      type: "skill-resource",
      content: "Installed content",
      origin: "upload",
      skillId: "agentSkill_1",
    });
  });

  test("refreshes content when explicitly requested for the same source", () => {
    const resource = {
      content: "Original content",
      label: "Guidance",
      mimeType: "text/markdown",
      origin: "authored" as const,
      resourcePath: "knowledge/guidance.md",
      skillId: "agentSkill_1",
      skillName: "review",
    };

    useInspectorTabsStore.getState().openSkillResourceTab(resource);
    useInspectorTabsStore
      .getState()
      .updateSkillResourceTabContent(
        buildSkillResourceTabId(resource),
        "Edited buffer",
      );
    useInspectorTabsStore.getState().openSkillResourceTab({
      ...resource,
      content: "Tool output",
      refreshContent: true,
    });

    const tab = useInspectorTabsStore
      .getState()
      .tabs.find((item) => item.id === buildSkillResourceTabId(resource));
    expect(tab).toMatchObject({
      type: "skill-resource",
      content: "Tool output",
    });
  });
});

describe("replaceFileFieldId", () => {
  test("re-opening an existing pdf tab refreshes the file label", () => {
    useInspectorTabsStore.getState().openFile({
      id: "field-1",
      entityId: "entity-1",
      label: "Document 4",
      fileName: "Document 4.pdf",
      mimeType: "application/pdf",
      pdfFileId: "pdf-1",
      propertyId: "property-1",
      workspaceId: "workspace-1",
    });

    useInspectorTabsStore.getState().openFile({
      id: "field-1",
      entityId: "entity-1",
      label: "0041_Pleadings_draft.pdf",
      fileName: "0041_Pleadings_draft.pdf",
      mimeType: "application/pdf",
      pdfFileId: "pdf-1",
      propertyId: "property-1",
      workspaceId: "workspace-1",
    });

    const tab = useInspectorTabsStore
      .getState()
      .tabs.find((item) => item.id === "field-1");
    if (tab?.type !== "pdf") {
      throw new Error("expected pdf tab");
    }

    expect(tab.label).toBe("0041_Pleadings_draft.pdf");
  });

  test("openFile with a different fieldId for the same entity keeps a single tab", () => {
    useInspectorTabsStore.getState().openFile({
      id: "field-v1",
      entityId: "entity-1",
      label: "Contract.docx",
      fileName: "Contract.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      pdfFileId: null,
      propertyId: "property-1",
      workspaceId: "workspace-1",
    });

    useInspectorTabsStore.getState().openFile({
      id: "field-v2",
      entityId: "entity-1",
      label: "Contract.docx",
      fileName: "Contract.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      pdfFileId: null,
      propertyId: "property-1",
      workspaceId: "workspace-1",
    });

    const pdfTabs = useInspectorTabsStore
      .getState()
      .tabs.filter((t) => t.type === "pdf");
    expect(pdfTabs).toHaveLength(1);
    expect(pdfTabs[0]?.id).toBe("field-v2");
    expect(useInspectorTabsStore.getState().activeId).toBe("field-v2");
  });

  test("resets the attachments facet when the reused tab stops showing an email", () => {
    useInspectorTabsStore.getState().openFile({
      id: "field-email",
      entityId: "entity-1",
      label: "Message",
      fileName: "message.eml",
      mimeType: "message/rfc822",
      pdfFileId: null,
      propertyId: "property-1",
      workspaceId: "workspace-1",
    });
    useInspectorTabsStore.getState().setFileFacet("field-email", "attachments");

    useInspectorTabsStore.getState().openFile({
      id: "field-pdf",
      entityId: "entity-1",
      label: "Contract",
      fileName: "contract.pdf",
      mimeType: "application/pdf",
      pdfFileId: null,
      propertyId: "property-1",
      workspaceId: "workspace-1",
    });

    const tab = useInspectorTabsStore
      .getState()
      .tabs.find((item) => item.id === "field-pdf");
    expect(tab).toMatchObject({ facet: "preview", type: "pdf" });
  });

  test("openFileForEntity drops a stale tab whose id collides with the new field", () => {
    useInspectorTabsStore.getState().openFile({
      id: "field-shared",
      entityId: "entity-A",
      label: "A.docx",
      fileName: "A.docx",
      mimeType: "application/pdf",
      pdfFileId: null,
      propertyId: "property-A",
      workspaceId: "workspace-1",
    });

    useInspectorTabsStore.getState().openFileForEntity({
      id: "field-shared",
      entityId: "entity-B",
      label: "B.docx",
      fileName: "B.docx",
      mimeType: "application/pdf",
      pdfFileId: null,
      propertyId: "property-B",
      workspaceId: "workspace-1",
    });

    const pdfTabs = useInspectorTabsStore
      .getState()
      .tabs.filter((t) => t.type === "pdf");
    expect(pdfTabs).toHaveLength(1);
    expect(pdfTabs[0]?.entityId).toBe("entity-B");
  });

  test("bumps the pdf tab render id across version replacement", () => {
    useInspectorTabsStore.getState().openFile({
      id: "field-old",
      entityId: "entity-1",
      label: "Contract.docx",
      fileName: "Contract.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      pdfFileId: null,
      propertyId: "property-1",
      workspaceId: "workspace-1",
    });

    const before = useInspectorTabsStore
      .getState()
      .tabs.find((tab) => tab.id === "field-old");
    if (before?.type !== "pdf") {
      throw new Error("expected pdf tab");
    }
    const beforeRenderId = before.renderId;

    useInspectorTabsStore
      .getState()
      .replaceFileFieldId("field-old", "field-new");

    const after = useInspectorTabsStore
      .getState()
      .tabs.find((tab) => tab.id === "field-new");
    if (after?.type !== "pdf") {
      throw new Error("expected pdf tab");
    }

    expect(after.renderId).not.toBe(beforeRenderId);
    expect(useInspectorTabsStore.getState().activeId).toBe("field-new");
  });

  test("refreshes file tab metadata across version replacement", () => {
    useInspectorTabsStore.getState().openFile({
      id: "field-old",
      entityId: "entity-1",
      label: "Contract.docx",
      fileName: "Contract.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      pdfFileId: null,
      propertyId: "property-1",
      workspaceId: "workspace-1",
    });

    useInspectorTabsStore.getState().replaceFileFieldId("field-old", {
      id: "field-new",
      fileName: "Contract revised.docx",
      label: "Contract revised.docx",
      mimeType: "application/pdf",
      pdfFileId: "pdf-1",
      propertyId: "property-2",
    });

    const tab = useInspectorTabsStore
      .getState()
      .tabs.find((item) => item.id === "field-new");
    if (tab?.type !== "pdf") {
      throw new Error("expected pdf tab");
    }

    expect(tab.label).toBe("Contract revised.docx");
    expect(tab.fileName).toBe("Contract revised.docx");
    expect(tab.mimeType).toBe("application/pdf");
    expect(tab.pdfFileId).toBe("pdf-1");
    expect(tab.propertyId).toBe("property-2");
  });

  test("resets attachments when a version replacement stops being an email", () => {
    useInspectorTabsStore.getState().openFile({
      id: "field-old",
      entityId: "entity-1",
      label: "Message",
      fileName: "message.eml",
      mimeType: "message/rfc822",
      pdfFileId: null,
      propertyId: "property-1",
      workspaceId: "workspace-1",
    });
    useInspectorTabsStore.getState().setFileFacet("field-old", "attachments");

    useInspectorTabsStore.getState().replaceFileFieldId("field-old", {
      id: "field-new",
      fileName: "contract.pdf",
      mimeType: "application/pdf",
    });

    expect(
      useInspectorTabsStore
        .getState()
        .tabs.find(({ id }) => id === "field-new"),
    ).toMatchObject({ facet: "preview", type: "pdf" });
  });
});

const openFullscreenFileTab = () => {
  useInspectorTabsStore.getState().openFile({
    id: "field-1",
    entityId: "entity-1",
    label: "Contract.docx",
    fileName: "Contract.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    metadataLane: "expanded",
    pdfFileId: null,
    propertyId: "property-1",
    workspaceId: "workspace-1",
  });
};

describe("revive suggestion", () => {
  test("user close of a fullscreen file tab leaves a suggestion; revive restores the exact tab", () => {
    openFullscreenFileTab();
    const before = useInspectorTabsStore
      .getState()
      .tabs.find((tab) => tab.id === "field-1");
    if (before?.type !== "pdf") {
      throw new Error("expected pdf tab");
    }

    useInspectorTabsStore
      .getState()
      .closeTab("field-1", { suggestRevive: true });
    expect(useInspectorTabsStore.getState().tabs).toHaveLength(0);
    expect(useInspectorTabsStore.getState().reviveSuggestion?.id).toBe(
      "field-1",
    );

    useInspectorTabsStore.getState().reviveSuggestedTab();
    const after = useInspectorTabsStore
      .getState()
      .tabs.find((tab) => tab.id === "field-1");
    // Same renderId = same tab identity; the viewer subtree and any
    // per-tab state reconnect instead of remounting fresh.
    expect(after).toEqual(before);
    expect(useInspectorTabsStore.getState().activeId).toBe("field-1");
    expect(useInspectorTabsStore.getState().reviveSuggestion).toBeNull();
  });

  test("programmatic close (route unmount) leaves no suggestion", () => {
    openFullscreenFileTab();
    useInspectorTabsStore.getState().closeTab("field-1");
    expect(useInspectorTabsStore.getState().reviveSuggestion).toBeNull();
  });

  test("closing a side-peek file tab leaves no suggestion", () => {
    useInspectorTabsStore.getState().openFile({
      id: "field-1",
      entityId: "entity-1",
      label: "Contract.docx",
      fileName: "Contract.docx",
      mimeType: "application/pdf",
      pdfFileId: null,
      propertyId: "property-1",
      workspaceId: "workspace-1",
    });
    useInspectorTabsStore
      .getState()
      .closeTab("field-1", { suggestRevive: true });
    expect(useInspectorTabsStore.getState().reviveSuggestion).toBeNull();
  });

  test("document route unmount clears the suggestion via lane demotion", () => {
    openFullscreenFileTab();
    useInspectorTabsStore
      .getState()
      .closeTab("field-1", { suggestRevive: true });
    expect(useInspectorTabsStore.getState().reviveSuggestion).not.toBeNull();

    useInspectorTabsStore.getState().setFileMetadataLane("field-1", "closed");
    expect(useInspectorTabsStore.getState().reviveSuggestion).toBeNull();
  });

  test("reopening another version of the same entity supersedes the suggestion", () => {
    openFullscreenFileTab();
    useInspectorTabsStore
      .getState()
      .closeTab("field-1", { suggestRevive: true });

    useInspectorTabsStore.getState().openFileForEntity({
      id: "field-2",
      entityId: "entity-1",
      label: "Contract.docx",
      fileName: "Contract.docx",
      mimeType: "application/pdf",
      pdfFileId: null,
      propertyId: "property-1",
      workspaceId: "workspace-1",
    });
    expect(useInspectorTabsStore.getState().reviveSuggestion).toBeNull();
  });

  test("closeAll keeps a suggestion for the swept-away bound tab", () => {
    openFullscreenFileTab();
    useInspectorTabsStore
      .getState()
      .openChat({ id: toChatThreadId("thread-1") });

    useInspectorTabsStore.getState().closeAll();
    expect(useInspectorTabsStore.getState().tabs).toHaveLength(0);
    expect(useInspectorTabsStore.getState().reviveSuggestion?.id).toBe(
      "field-1",
    );
  });

  test("updating a view payload preserves the user's active tab", () => {
    useInspectorTabsStore.getState().openView({
      type: "test-live-view",
      id: "test-live-view:1",
      label: "Draft",
      payload: { source: "First" },
    });
    useInspectorTabsStore
      .getState()
      .openChat({ id: toChatThreadId("thread-1") });
    const activationSeq = useInspectorTabsStore.getState().activationSeq;

    useInspectorTabsStore.getState().updateView({
      id: "test-live-view:1",
      label: "Updated draft",
      payload: { source: "Second" },
    });

    const state = useInspectorTabsStore.getState();
    expect(state.activeId).toBe("thread-1");
    expect(state.activationSeq).toBe(activationSeq);
    expect(state.tabs.find((tab) => tab.id === "test-live-view:1")).toEqual({
      type: "view",
      viewType: "test-live-view",
      id: "test-live-view:1",
      label: "Updated draft",
      payload: { source: "Second" },
    });
  });

  test("route-owned view tab: user close suggests, owner unmount close clears", () => {
    registerInspectorView<{ templateId: string }>({
      type: "test-bound-view",
      navigationPolicy: "close-on-route-leave",
      railIcon: () => null,
      render: () => null,
      validate: (value): value is { templateId: string } =>
        typeof value === "object" &&
        value !== null &&
        "templateId" in value &&
        typeof value.templateId === "string",
    });
    useInspectorTabsStore.getState().openView({
      type: "test-bound-view",
      id: "test-bound-view:tpl-1",
      label: "NDA template",
      payload: { templateId: "tpl-1" },
      ownerRouteId: "/_protected/knowledge/templates",
    });

    useInspectorTabsStore
      .getState()
      .closeTab("test-bound-view:tpl-1", { suggestRevive: true });
    const suggestion = useInspectorTabsStore.getState().reviveSuggestion;
    expect(suggestion?.id).toBe("test-bound-view:tpl-1");
    if (suggestion?.type !== "view") {
      throw new Error("expected view suggestion");
    }
    expect(suggestion.payload).toEqual({ templateId: "tpl-1" });

    // The owner page unmounts (user leaves the studio) and runs its
    // cleanup close for a tab that is already gone — the suggestion
    // must not outlive the main view it points at.
    useInspectorTabsStore.getState().closeTab("test-bound-view:tpl-1");
    expect(useInspectorTabsStore.getState().reviveSuggestion).toBeNull();
  });
});

describe("closeTabsForEntities", () => {
  test("clears the inspector when its only file is deleted", () => {
    useInspectorTabsStore.getState().openFile({
      id: "field-1",
      entityId: "entity-1",
      label: "Contract.pdf",
      fileName: "Contract.pdf",
      mimeType: "application/pdf",
      pdfFileId: null,
      workspaceId: "workspace-1",
    });

    closeInspectorTabsForEntities(["entity-1"]);

    expect(useInspectorTabsStore.getState().tabs).toEqual([]);
    expect(useInspectorTabsStore.getState().activeId).toBeNull();
  });

  test("activates the nearest surviving tab after deleting the active file", () => {
    useInspectorTabsStore.getState().openFile({
      id: "field-before",
      entityId: "entity-before",
      label: "Before.pdf",
      fileName: "Before.pdf",
      mimeType: "application/pdf",
      pdfFileId: null,
      workspaceId: "workspace-1",
    });
    useInspectorTabsStore.getState().openFile({
      id: "field-1",
      entityId: "entity-1",
      label: "Contract.pdf",
      fileName: "Contract.pdf",
      mimeType: "application/pdf",
      pdfFileId: null,
      workspaceId: "workspace-1",
    });
    useInspectorTabsStore.getState().openChat({
      id: toChatThreadId("thread-after"),
    });
    useInspectorTabsStore.getState().openChat({
      id: toChatThreadId("thread-last"),
    });
    useInspectorTabsStore.getState().setActive("field-1");

    closeInspectorTabsForEntities(["entity-before", "entity-1"]);

    expect(useInspectorTabsStore.getState().tabs.map((tab) => tab.id)).toEqual([
      "thread-after",
      "thread-last",
    ]);
    expect(useInspectorTabsStore.getState().activeId).toBe("thread-after");
  });

  test("closes every deleted entity tab and clears a stale revive suggestion", () => {
    openFullscreenFileTab();
    useInspectorTabsStore
      .getState()
      .closeTab("field-1", { suggestRevive: true });
    useInspectorTabsStore.getState().openTask({
      taskId: "entity-2",
      workspaceId: "workspace-1",
    });
    useInspectorTabsStore.getState().openFile({
      id: "field-3",
      entityId: "entity-3",
      label: "Keep.pdf",
      fileName: "Keep.pdf",
      mimeType: "application/pdf",
      pdfFileId: null,
      workspaceId: "workspace-1",
    });

    closeInspectorTabsForEntities(["entity-1", "entity-2"]);

    expect(useInspectorTabsStore.getState().tabs.map((tab) => tab.id)).toEqual([
      "field-3",
    ]);
    expect(useInspectorTabsStore.getState().activeId).toBe("field-3");
    expect(useInspectorTabsStore.getState().reviveSuggestion).toBeNull();
  });

  test("preserves the active tab when another entity is deleted", () => {
    useInspectorTabsStore.getState().openFile({
      id: "field-1",
      entityId: "entity-1",
      label: "Delete.pdf",
      fileName: "Delete.pdf",
      mimeType: "application/pdf",
      pdfFileId: null,
      workspaceId: "workspace-1",
    });
    useInspectorTabsStore.getState().openChat({
      id: toChatThreadId("thread-keep"),
    });

    closeInspectorTabsForEntities(["entity-1"]);

    expect(useInspectorTabsStore.getState().activeId).toBe("thread-keep");
  });

  test("preserves the tabs reference when no open tab was deleted", () => {
    useInspectorTabsStore.getState().openChat({
      id: toChatThreadId("thread-keep"),
    });
    const tabsBefore = useInspectorTabsStore.getState().tabs;

    closeInspectorTabsForEntities(["entity-missing"]);

    expect(useInspectorTabsStore.getState().tabs).toBe(tabsBefore);
  });
});

describe("Inspector tab broadcast", () => {
  test("preserves the email attachments facet in the broadcast domain", () => {
    expect(isFileFacet("attachments")).toBe(true);
    expect(isFileFacet("unknown")).toBe(false);
  });

  test("publishes tab set metadata without sharing local active state", () => {
    installFakeBroadcastChannel();
    const scope = { organizationId: "org-1", userId: "user-1" };
    const peer = new FakeBroadcastChannel(
      getInspectorTabsBroadcastChannelName(scope),
    );
    const received: unknown[] = [];
    peer.addEventListener("message", (event) => {
      received.push(event.data);
    });

    cleanupInspectorBroadcast = initializeInspectorTabBroadcast(scope);

    useInspectorTabsStore.getState().openFile({
      id: "field-1",
      entityId: "entity-1",
      label: "Contract.docx",
      fileName: "Contract.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      pdfFileId: null,
      propertyId: "property-1",
      workspaceId: "workspace-1",
    });
    useInspectorTabsStore.getState().setFileFacet("field-1", "versions", {
      pulse: true,
    });

    const syncMessage = received.findLast(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        Reflect.get(message, "type") === "inspector-tabs:sync",
    );
    expect(syncMessage).toBeDefined();
    expect(Reflect.get(syncMessage ?? {}, "tabs")).toEqual(
      useInspectorTabsStore.getState().tabs,
    );
    expect(Reflect.get(syncMessage ?? {}, "activeId")).toBeUndefined();
    expect(Reflect.get(syncMessage ?? {}, "minimized")).toBeUndefined();
  });

  test("hydrates tab set from another browser tab and chooses a local active tab", () => {
    installFakeBroadcastChannel();
    const scope = { organizationId: "org-1", userId: "user-1" };
    const peer = new FakeBroadcastChannel(
      getInspectorTabsBroadcastChannelName(scope),
    );

    peer.addEventListener("message", (event) => {
      const message = event.data;
      if (
        typeof message !== "object" ||
        message === null ||
        Reflect.get(message, "type") !== "inspector-tabs:request"
      ) {
        return;
      }

      peer.emit({
        type: "inspector-tabs:sync",
        senderId: "peer-tab",
        recipientId: Reflect.get(message, "senderId"),
        updatedAt: 1,
        tabs: [
          {
            type: "chat",
            id: toChatThreadId("thread-1"),
            label: "Shared chat",
            workspaceId: "workspace-1",
            contextMatterIds: ["workspace-1"],
          },
        ],
      });
    });

    cleanupInspectorBroadcast = initializeInspectorTabBroadcast(scope);

    expect(useInspectorTabsStore.getState().tabs).toEqual([
      {
        type: "chat",
        id: toChatThreadId("thread-1"),
        label: "Shared chat",
        workspaceId: "workspace-1",
        contextMatterIds: ["workspace-1"],
      },
    ]);
    expect(useInspectorTabsStore.getState().activeId).toBe("thread-1");
  });

  test("normalizes task tabs from browser tabs created before creation status existed", () => {
    installFakeBroadcastChannel();
    const scope = { organizationId: "org-1", userId: "user-1" };
    const peer = new FakeBroadcastChannel(
      getInspectorTabsBroadcastChannelName(scope),
    );
    cleanupInspectorBroadcast = initializeInspectorTabBroadcast(scope);

    peer.emit({
      type: "inspector-tabs:sync",
      senderId: "peer-tab",
      updatedAt: 1,
      tabs: [
        {
          type: "task",
          id: "task-1",
          label: "Existing task",
          isNew: false,
          workspaceId: "workspace-1",
        },
      ],
    });

    expect(useInspectorTabsStore.getState().tabs).toEqual([
      {
        type: "task",
        id: "task-1",
        creationStatus: "ready",
        label: "Existing task",
        isNew: false,
        workspaceId: "workspace-1",
      },
    ]);
  });

  test("keeps local active tab when the shared tab set still contains it", () => {
    installFakeBroadcastChannel();
    const scope = { organizationId: "org-1", userId: "user-1" };
    const peer = new FakeBroadcastChannel(
      getInspectorTabsBroadcastChannelName(scope),
    );

    const localThreadId = toChatThreadId("thread-local");
    useInspectorTabsStore.getState().openChat({ id: localThreadId });
    cleanupInspectorBroadcast = initializeInspectorTabBroadcast(scope);

    peer.emit({
      type: "inspector-tabs:sync",
      senderId: "peer-tab",
      updatedAt: 1,
      tabs: [
        {
          type: "chat",
          id: toChatThreadId("thread-remote"),
          label: "Remote chat",
          contextMatterIds: [],
        },
        {
          type: "chat",
          id: localThreadId,
          label: "Local chat renamed elsewhere",
          contextMatterIds: [],
        },
      ],
    });

    expect(useInspectorTabsStore.getState().activeId).toBe(localThreadId);
    expect(useInspectorTabsStore.getState().tabs).toEqual([
      {
        type: "chat",
        id: toChatThreadId("thread-remote"),
        label: "Remote chat",
        contextMatterIds: [],
      },
      {
        type: "chat",
        id: localThreadId,
        label: "Local chat renamed elsewhere",
        contextMatterIds: [],
      },
    ]);
  });

  test("uses sender id as deterministic tie-breaker for same-ms updates", () => {
    freezeDateNow(100);
    installFakeBroadcastChannel();
    const scope = { organizationId: "org-1", userId: "user-1" };
    const peer = new FakeBroadcastChannel(
      getInspectorTabsBroadcastChannelName(scope),
    );
    const received: unknown[] = [];
    peer.addEventListener("message", (event) => {
      received.push(event.data);
    });

    cleanupInspectorBroadcast = initializeInspectorTabBroadcast(scope);

    const localThreadId = toChatThreadId("thread-local");
    useInspectorTabsStore.getState().openChat({
      id: localThreadId,
      label: "Local chat",
    });

    const syncMessage = received.findLast(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        Reflect.get(message, "type") === "inspector-tabs:sync",
    );
    const localSenderId = Reflect.get(syncMessage ?? {}, "senderId");
    expect(typeof localSenderId).toBe("string");
    if (typeof localSenderId !== "string") {
      throw new TypeError("expected local sender id");
    }

    const lowerPeerThreadId = toChatThreadId("thread-lower-peer");
    peer.emit({
      type: "inspector-tabs:sync",
      senderId: "00000000-0000-0000-0000-000000000000",
      updatedAt: 100,
      tabs: [
        {
          type: "chat",
          id: lowerPeerThreadId,
          label: "Lower peer chat",
          contextMatterIds: [],
        },
      ],
    });
    expect(useInspectorTabsStore.getState().tabs).toEqual([
      {
        type: "chat",
        id: localThreadId,
        label: "Local chat",
        contextMatterIds: [],
      },
    ]);

    const higherPeerThreadId = toChatThreadId("thread-higher-peer");
    peer.emit({
      type: "inspector-tabs:sync",
      senderId: "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",
      updatedAt: 100,
      tabs: [
        {
          type: "chat",
          id: higherPeerThreadId,
          label: "Higher peer chat",
          contextMatterIds: [],
        },
      ],
    });
    expect(useInspectorTabsStore.getState().tabs).toEqual([
      {
        type: "chat",
        id: higherPeerThreadId,
        label: "Higher peer chat",
        contextMatterIds: [],
      },
    ]);
  });

  test("hydrates external tabs from another browser tab", () => {
    installFakeBroadcastChannel();
    const scope = { organizationId: "org-1", userId: "user-1" };
    const peer = new FakeBroadcastChannel(
      getInspectorTabsBroadcastChannelName(scope),
    );
    const chatThreadId = toChatThreadId("thread-external");

    peer.addEventListener("message", (event) => {
      const message = event.data;
      if (
        typeof message !== "object" ||
        message === null ||
        Reflect.get(message, "type") !== "inspector-tabs:request"
      ) {
        return;
      }

      peer.emit({
        type: "inspector-tabs:sync",
        senderId: "peer-tab",
        recipientId: Reflect.get(message, "senderId"),
        updatedAt: 1,
        tabs: [
          {
            type: "external",
            id: "external:https://example.test/decision",
            chatThreadId,
            label: "External decision",
            url: "https://example.test/decision",
            connectorSlug: "salvia",
            iconHref: "https://example.test/favicon.ico",
            provider: "example",
            snippet: "Holding excerpt",
            sourceToolName: "search_decisions",
            text: "Decision text",
            workspaceId: null,
          },
        ],
      });
    });

    cleanupInspectorBroadcast = initializeInspectorTabBroadcast(scope);

    expect(useInspectorTabsStore.getState().tabs).toEqual([
      {
        type: "external",
        id: "external:https://example.test/decision",
        chatThreadId,
        label: "External decision",
        url: "https://example.test/decision",
        connectorSlug: "salvia",
        iconHref: "https://example.test/favicon.ico",
        provider: "example",
        snippet: "Holding excerpt",
        sourceToolName: "search_decisions",
        text: "Decision text",
        workspaceId: null,
      },
    ]);
    expect(useInspectorTabsStore.getState().activeId).toBe(
      "external:https://example.test/decision",
    );
  });

  test("rejects external tabs with an invalid workspace scope", () => {
    installFakeBroadcastChannel();
    const scope = { organizationId: "org-1", userId: "user-1" };
    const peer = new FakeBroadcastChannel(
      getInspectorTabsBroadcastChannelName(scope),
    );
    cleanupInspectorBroadcast = initializeInspectorTabBroadcast(scope);

    peer.emit({
      type: "inspector-tabs:sync",
      senderId: "peer-tab",
      updatedAt: 1,
      tabs: [
        {
          type: "external",
          id: "external:https://example.test/decision",
          chatThreadId: toChatThreadId("thread-external"),
          label: "External decision",
          url: "https://example.test/decision",
          workspaceId: 42,
        },
      ],
    });

    expect(useInspectorTabsStore.getState().tabs).toEqual([]);
  });

  test("keeps local tab mutations when browser broadcast fails", () => {
    installFakeBroadcastChannel();
    cleanupInspectorBroadcast = initializeInspectorTabBroadcast({
      organizationId: "org-1",
      userId: "user-1",
    });
    FakeBroadcastChannel.postError = new DOMException(
      "The object could not be cloned.",
      "DataCloneError",
    );

    expect(() =>
      useInspectorTabsStore
        .getState()
        .openChat({ id: toChatThreadId("thread-local") }),
    ).not.toThrow();
    expect(useInspectorTabsStore.getState().tabs).toHaveLength(1);
  });

  test("does not exchange tabs across organization scopes", () => {
    installFakeBroadcastChannel();
    const peer = new FakeBroadcastChannel(
      getInspectorTabsBroadcastChannelName({
        organizationId: "org-2",
        userId: "user-1",
      }),
    );
    const received: unknown[] = [];
    peer.addEventListener("message", (event) => {
      received.push(event.data);
    });

    cleanupInspectorBroadcast = initializeInspectorTabBroadcast({
      organizationId: "org-1",
      userId: "user-1",
    });
    useInspectorTabsStore
      .getState()
      .openChat({ id: toChatThreadId("thread-1") });

    expect(received).toEqual([]);
  });
});
