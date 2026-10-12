import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { browserStorage } from "@/lib/account/browser-storage";

GlobalRegistrator.register({
  url: "http://localhost:3000/law/cze/cases/us/iv-us-1394-24",
});

const { act, cleanup, render } = await import("@testing-library/react");
const { createCaseDecisionDetailsTab } =
  await import("@/components/inspector/case-decision-details-view");
const { INSPECTOR_PANE_INTENT } =
  await import("@/components/inspector/inspector-store-types");
const { useInspectorTabsStore } =
  await import("@/components/inspector/inspector-tabs-store");
const { decisionChatKey } =
  await import("@/features/chat/legal-document-chat-key");
const { useLegalDocumentChatThreads } =
  await import("@/features/chat/legal-document-chat-threads");
const { installUserScopedStorage } =
  await import("@/lib/account/install-user-scoped-storage");
const { releaseUserStorage, userStorageKey } =
  await import("@/lib/account/user-scoped-storage");
const { rootKeys } = await import("@/lib/auth-queries");
const { toSafeId } = await import("@/lib/safe-id");
const { MemberInspectorPersistence } =
  await import("@/routes/law/-components/public-law-inspector");

const localArea = () =>
  browserStorage("local") ?? panic("Test requires local browser storage");

const MEMBER = {
  activeOrganizationId: "organization-1",
  email: "member@example.com",
  id: "user-1",
  image: null,
  name: "Member",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};
const DECISION_ID = toSafeId<"caseLawDecision">(
  "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d",
);
const SAVED_THREAD_ID = "0b1c2d3e-4f50-4a6b-8c7d-000000000001";

const ownerKey = (prefix: string) =>
  userStorageKey(`${prefix}:${MEMBER.activeOrganizationId}:`, {
    kind: "user",
    userId: MEMBER.id,
  });

let uninstallStorage: (() => void) | undefined;

afterEach(() => {
  cleanup();
  uninstallStorage?.();
  uninstallStorage = undefined;
  releaseUserStorage();
  localArea().clear();
  useLegalDocumentChatThreads.setState({ threadIdByDocumentKey: {} });
  useInspectorTabsStore.setState({
    tabs: [],
    groups: [],
    groupAssignments: {},
    collapsedGroupIds: [],
    activeId: null,
    minimized: false,
    reviveSuggestion: null,
  });
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/** What a member left behind: the decision's chat tab, with the pane folded. */
const persistDecisionChat = () => {
  localArea().setItem(
    ownerKey("stella:inspector-state:v1"),
    JSON.stringify({
      activeId: SAVED_THREAD_ID,
      collapsedGroupIds: [],
      groupAssignments: {},
      groups: [],
      tabs: [
        {
          activeLegalKey: decisionChatKey(DECISION_ID),
          contextMatterIds: [],
          id: SAVED_THREAD_ID,
          label: "Decision chat",
          type: "chat",
        },
      ],
    }),
  );
  localArea().setItem(ownerKey("stella:inspector-minimized:v1"), "1");
};

/** The decision page's own seeding, in its order: details tab, then chat. */
const openDecisionPage = () => {
  const store = useInspectorTabsStore.getState();
  store.openView({
    ...createCaseDecisionDetailsTab({
      caseNumber: "IV.ÚS 1394/24",
      country: "CZE",
      court: "Ústavní soud",
      decisionId: DECISION_ID,
      language: "cs",
      languageAlternates: [],
      slug: "iv-us-1394-24",
    }),
    ownerRouteId: "/law/$country/cases/$court/$slug",
    pane: INSPECTOR_PANE_INTENT.keep,
  });
  store.openChat({
    activeLegalKey: decisionChatKey(DECISION_ID),
    pane: INSPECTOR_PANE_INTENT.keep,
  });
};

describe("a member returning to a decision on the public law surface", () => {
  test("continues the decision's saved chat beside the page's own tabs", () => {
    const client = new QueryClient();
    uninstallStorage = installUserScopedStorage(client);
    act(() => {
      client.setQueryData(rootKeys.session, { user: { id: MEMBER.id } });
    });
    persistDecisionChat();

    render(<MemberInspectorPersistence user={MEMBER} />);
    act(openDecisionPage);

    const { activeId, minimized, tabs } = useInspectorTabsStore.getState();
    const chats = tabs.filter((tab) => tab.type === "chat");
    // The saved conversation, not a fresh thread minted for the page.
    expect(chats.map((tab) => tab.id)).toEqual([SAVED_THREAD_ID]);
    expect(activeId).toBe(SAVED_THREAD_ID);
    // The page's details tab sits beside it, and the pane stays as the
    // member left it.
    expect(tabs.map((tab) => tab.id)).toContain(
      createCaseDecisionDetailsTab({
        caseNumber: "IV.ÚS 1394/24",
        country: "CZE",
        court: "Ústavní soud",
        decisionId: DECISION_ID,
        language: "cs",
        languageAlternates: [],
        slug: "iv-us-1394-24",
      }).id,
    );
    expect(minimized).toBe(true);
  });

  test("without the restore, the page would start a new conversation", () => {
    const client = new QueryClient();
    uninstallStorage = installUserScopedStorage(client);
    act(() => {
      client.setQueryData(rootKeys.session, { user: { id: MEMBER.id } });
    });
    persistDecisionChat();

    act(openDecisionPage);

    // The baseline the first test guards against: the saved tab is ignored
    // and the decision's chat lands on a thread nobody has written in.
    const chats = useInspectorTabsStore
      .getState()
      .tabs.filter((tab) => tab.type === "chat");
    expect(chats).toHaveLength(1);
    expect(chats.at(0)?.id).not.toBe(SAVED_THREAD_ID);
  });
});
