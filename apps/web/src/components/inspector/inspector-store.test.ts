import { afterEach, describe, expect, test } from "bun:test";

import {
  buildSkillResourceTabId,
  getInspectorTabsBroadcastChannelName,
  initializeInspectorTabBroadcast,
  useInspectorStore,
} from "@/components/inspector/inspector-store";
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
  useInspectorStore.setState({
    tabs: [],
    activeId: null,
    activationSeq: 0,
    pendingRenameTabId: null,
    minimized: false,
    pendingBlockScroll: null,
  });
});

class FakeBroadcastChannel {
  static channels = new Map<string, Set<FakeBroadcastChannel>>();

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
      workspaceId: "ws-origin",
    });

    useInspectorStore.getState().openExternal({
      label: "Decision",
      url: "https://example.test/decision",
      workspaceId: "ws-origin",
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

    useInspectorStore.getState().openSkillResourceTab(resource);
    useInspectorStore
      .getState()
      .updateSkillResourceTabContent(
        buildSkillResourceTabId(resource),
        "Edited content",
      );
    useInspectorStore.getState().openSkillResourceTab({
      ...resource,
      content: "Stale tool output",
    });

    const tab = useInspectorStore
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

    useInspectorStore.getState().openSkillResourceTab(resource);
    useInspectorStore.getState().openSkillResourceTab({
      ...resource,
      content: "Installed content",
      origin: "upload",
      skillId: "agentSkill_1",
    });

    const tab = useInspectorStore
      .getState()
      .tabs.find((item) => item.id === buildSkillResourceTabId(resource));
    expect(tab).toMatchObject({
      type: "skill-resource",
      content: "Installed content",
      origin: "upload",
      skillId: "agentSkill_1",
    });
  });
});

describe("replaceFileFieldId", () => {
  test("re-opening an existing pdf tab refreshes the file label", () => {
    useInspectorStore.getState().openFile({
      id: "field-1",
      entityId: "entity-1",
      label: "Document 4",
      fileName: "Document 4.pdf",
      mimeType: "application/pdf",
      pdfFileId: "pdf-1",
      propertyId: "property-1",
      workspaceId: "workspace-1",
    });

    useInspectorStore.getState().openFile({
      id: "field-1",
      entityId: "entity-1",
      label: "0041_Pleadings_draft.pdf",
      fileName: "0041_Pleadings_draft.pdf",
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

  test("openFile with a different fieldId for the same entity keeps a single tab", () => {
    useInspectorStore.getState().openFile({
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

    useInspectorStore.getState().openFile({
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

    const pdfTabs = useInspectorStore
      .getState()
      .tabs.filter((t) => t.type === "pdf");
    expect(pdfTabs).toHaveLength(1);
    expect(pdfTabs[0]?.id).toBe("field-v2");
    expect(useInspectorStore.getState().activeId).toBe("field-v2");
  });

  test("openFileForEntity drops a stale tab whose id collides with the new field", () => {
    useInspectorStore.getState().openFile({
      id: "field-shared",
      entityId: "entity-A",
      label: "A.docx",
      fileName: "A.docx",
      mimeType: "application/pdf",
      pdfFileId: null,
      propertyId: "property-A",
      workspaceId: "workspace-1",
    });

    useInspectorStore.getState().openFileForEntity({
      id: "field-shared",
      entityId: "entity-B",
      label: "B.docx",
      fileName: "B.docx",
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

  test("bumps the pdf tab render id across version replacement", () => {
    useInspectorStore.getState().openFile({
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

    const before = useInspectorStore
      .getState()
      .tabs.find((tab) => tab.id === "field-old");
    if (before?.type !== "pdf") {
      throw new Error("expected pdf tab");
    }
    const beforeRenderId = before.renderId;

    useInspectorStore.getState().replaceFileFieldId("field-old", "field-new");

    const after = useInspectorStore
      .getState()
      .tabs.find((tab) => tab.id === "field-new");
    if (after?.type !== "pdf") {
      throw new Error("expected pdf tab");
    }

    expect(after.renderId).not.toBe(beforeRenderId);
    expect(useInspectorStore.getState().activeId).toBe("field-new");
  });

  test("refreshes file tab metadata across version replacement", () => {
    useInspectorStore.getState().openFile({
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

    useInspectorStore.getState().replaceFileFieldId("field-old", {
      id: "field-new",
      fileName: "Contract revised.docx",
      label: "Contract revised.docx",
      mimeType: "application/pdf",
      pdfFileId: "pdf-1",
      propertyId: "property-2",
    });

    const tab = useInspectorStore
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
});

describe("Inspector tab broadcast", () => {
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

    useInspectorStore.getState().openFile({
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
    useInspectorStore.getState().setFileFacet("field-1", "versions", {
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
      useInspectorStore.getState().tabs,
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

    expect(useInspectorStore.getState().tabs).toEqual([
      {
        type: "chat",
        id: toChatThreadId("thread-1"),
        label: "Shared chat",
        workspaceId: "workspace-1",
        contextMatterIds: ["workspace-1"],
      },
    ]);
    expect(useInspectorStore.getState().activeId).toBe("thread-1");
  });

  test("keeps local active tab when the shared tab set still contains it", () => {
    installFakeBroadcastChannel();
    const scope = { organizationId: "org-1", userId: "user-1" };
    const peer = new FakeBroadcastChannel(
      getInspectorTabsBroadcastChannelName(scope),
    );

    const localThreadId = toChatThreadId("thread-local");
    useInspectorStore.getState().openChat({ id: localThreadId });
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

    expect(useInspectorStore.getState().activeId).toBe(localThreadId);
    expect(useInspectorStore.getState().tabs).toEqual([
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
    useInspectorStore.getState().openChat({
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
    expect(useInspectorStore.getState().tabs).toEqual([
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
    expect(useInspectorStore.getState().tabs).toEqual([
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

    expect(useInspectorStore.getState().tabs).toEqual([
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
    expect(useInspectorStore.getState().activeId).toBe(
      "external:https://example.test/decision",
    );
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
    useInspectorStore.getState().openChat({ id: toChatThreadId("thread-1") });

    expect(received).toEqual([]);
  });
});
