import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import type { ChatHistoryItem } from "@/features/chat/queries";

import type { ChatThreadDecision } from "./chat-thread-decision";

// Wide enough for the inspector: below `md` the hook leaves every click to
// the row's link.
GlobalRegistrator.register({ url: "http://localhost:3000/chat", width: 1280 });

const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { createCaseDecisionViewTab } =
  await import("@/components/inspector/case-decision-view");
const { useInspectorTabsStore } =
  await import("@/components/inspector/inspector-tabs-store");
const { decisionChatKey } =
  await import("@/features/chat/legal-document-chat-key");
const { toSafeId } = await import("@/lib/safe-id");
const { useOpenChatThreadDecision } = await import("./chat-thread-decision");

afterEach(() => {
  cleanup();
  useInspectorTabsStore.setState({ tabs: [], activeId: null });
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const DECISION_ID = "00000000-0000-0000-0000-000000000006";

const DECISION: ChatThreadDecision = {
  caseNumber: "25 Cdo 1234/2021",
  country: "CZE",
  court: "Nejvyšší soud",
  courtAbbreviation: "NS",
  courtTier: "supreme",
  decisionDate: "2021-03-12",
  id: toSafeId<"caseLawDecision">(DECISION_ID),
  language: "cs",
  languageAlternates: [],
  slug: "open-case",
};

const THREAD = {
  context: { fileCount: 0, files: [], matterCount: 0, matters: [] },
  createdAt: "2026-05-16T08:00:00.000Z",
  decision: { type: "present" as const, badge: DECISION },
  origin: "original" as const,
  title: "Liability for damage",
  updatedAt: "2026-05-16T08:00:00.000Z",
  usedAnonymization: false,
};

const GLOBAL_CHAT = {
  ...THREAD,
  id: "thread-global",
  scope: "global" as const,
} satisfies ChatHistoryItem;

const WORKSPACE_CHAT = {
  ...THREAD,
  id: "thread-workspace",
  scope: "workspace" as const,
  workspaceId: "workspace-1",
  workspaceName: "Matter A",
} satisfies ChatHistoryItem;

type Outcome = { handled: boolean | null; notPrevented: boolean };

/**
 * Clicks a history row whose handler is the hook, the way the row wires it,
 * and reports what the hook answered and whether the link's own navigation
 * was left alone.
 */
const clickRow = (chat: ChatHistoryItem, init: MouseEventInit = {}) => {
  const outcome: Outcome = { handled: null, notPrevented: true };
  const Row = () => {
    const open = useOpenChatThreadDecision();
    return (
      <a
        href="#transcript"
        onClick={(event) => {
          outcome.handled = open(event, chat);
        }}
      >
        {chat.title}
      </a>
    );
  };
  const view = render(<Row />);
  outcome.notPrevented = fireEvent.click(
    view.getByRole("link", { name: chat.title }),
    { button: 0, ...init },
  );
  return outcome;
};

const decisionTab = () =>
  createCaseDecisionViewTab({
    caseNumber: DECISION.caseNumber,
    country: DECISION.country,
    court: DECISION.court,
    decisionId: toSafeId<"caseLawDecision">(DECISION_ID),
    language: DECISION.language,
    languageAlternates: DECISION.languageAlternates,
    slug: DECISION.slug,
  });

describe("opening a decision chat from history", () => {
  test("a plain click on a matter chat opens its decision and, in front, the chat in its matter", () => {
    expect(clickRow(WORKSPACE_CHAT)).toEqual({
      handled: true,
      notPrevented: false,
    });

    const { activeId, tabs } = useInspectorTabsStore.getState();
    const expected = decisionTab();
    expect(tabs.map((tab) => tab.id)).toEqual([expected.id, WORKSPACE_CHAT.id]);
    const decision = tabs.at(0) ?? panic("No decision tab");
    expect(decision).toMatchObject({
      type: "view",
      viewType: expected.type,
      payload: expected.payload,
    });
    expect(expected.payload).toMatchObject({ decisionId: DECISION_ID });
    expect(tabs.at(1)).toMatchObject({
      type: "chat",
      id: WORKSPACE_CHAT.id,
      label: WORKSPACE_CHAT.title,
      activeLegalKey: decisionChatKey(DECISION_ID),
      workspaceId: WORKSPACE_CHAT.workspaceId,
    });
    expect(activeId).toBe(WORKSPACE_CHAT.id);
  });

  test("a plain click on a global chat opens it beside its decision with no matter", () => {
    expect(clickRow(GLOBAL_CHAT)).toEqual({
      handled: true,
      notPrevented: false,
    });

    const { activeId, tabs } = useInspectorTabsStore.getState();
    expect(tabs.map((tab) => tab.id)).toEqual([
      decisionTab().id,
      GLOBAL_CHAT.id,
    ]);
    const chat = tabs.at(1) ?? panic("No chat tab");
    expect(chat).toMatchObject({
      type: "chat",
      id: GLOBAL_CHAT.id,
      activeLegalKey: decisionChatKey(DECISION_ID),
    });
    expect(chat.type === "chat" ? chat.workspaceId : "not a chat").toBe(
      undefined,
    );
    expect(activeId).toBe(GLOBAL_CHAT.id);
  });

  test.each([
    ["meta", { metaKey: true }],
    ["ctrl", { ctrlKey: true }],
    ["shift", { shiftKey: true }],
    ["alt", { altKey: true }],
    ["middle button", { button: 1 }],
  ])(
    "a %s click follows the link to the transcript",
    (_gesture, init: MouseEventInit) => {
      expect(clickRow(WORKSPACE_CHAT, init)).toEqual({
        handled: false,
        notPrevented: true,
      });
      expect(useInspectorTabsStore.getState().tabs).toEqual([]);
    },
  );

  test("a chat with no decision to draw follows the link", () => {
    for (const decision of [null, { type: "unavailable" }] as const) {
      expect(clickRow({ ...WORKSPACE_CHAT, decision })).toEqual({
        handled: false,
        notPrevented: true,
      });
      cleanup();
    }
    expect(useInspectorTabsStore.getState().tabs).toEqual([]);
  });

  test("without an inspector (a phone) the click follows the link", () => {
    const matchMedia = window.matchMedia.bind(window);
    // Every width query answers as a viewport narrower than `md` does.
    window.matchMedia = () => matchMedia("(max-width: 1px)");
    try {
      expect(clickRow(WORKSPACE_CHAT)).toEqual({
        handled: false,
        notPrevented: true,
      });
      expect(useInspectorTabsStore.getState().tabs).toEqual([]);
    } finally {
      window.matchMedia = matchMedia;
    }
  });
});
