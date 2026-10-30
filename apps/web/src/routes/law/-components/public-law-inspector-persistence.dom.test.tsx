import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { panic } from "better-result";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { browserStorage } from "@/lib/account/browser-storage";
import { unregisterDomEnvironment } from "@/test-dom-environment";

const DECISION_HREF = "/law/cze/cases/ns/27-cdo-59-2022";

GlobalRegistrator.register({ url: `http://localhost:3000${DECISION_HREF}` });

const { act, cleanup, render } = await import("@testing-library/react");
const {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { createCaseDecisionDetailsTab } =
  await import("@/components/inspector/case-decision-details-view");
const { INSPECTOR_PANE_INTENT } =
  await import("@/components/inspector/inspector-store-types");
const {
  inspectorMinimizedEntry,
  inspectorRestorePendingEntry,
  inspectorStateEntry,
} = await import("@/components/inspector/inspector-storage-keys");
const { useInspectorTabsStore } =
  await import("@/components/inspector/inspector-tabs-store");
const { SidebarProvider } = await import("@/components/sidebar");
const { decisionChatKey } =
  await import("@/features/chat/legal-document-chat-key");
const { useLegalDocumentChatThreads } =
  await import("@/features/chat/legal-document-chat-threads");
const en = (await import("@/i18n/langs/en.json")).default;
const { installUserScopedStorage } =
  await import("@/lib/account/install-user-scoped-storage");
const { releaseUserStorage } =
  await import("@/lib/account/user-scoped-storage");
const { rootKeys } = await import("@/lib/auth-queries");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { toChatThreadId } = await import("@/lib/chat-thread-ref");
const { readPersistedState, writePersistedState } =
  await import("@/lib/persisted-state/registry");
const { toSafeId } = await import("@/lib/safe-id");
const { PublicLawInspector } =
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
const SAVED_THREAD_ID = toChatThreadId("0b1c2d3e-4f50-4a6b-8c7d-000000000001");
const DETAILS_TAB = createCaseDecisionDetailsTab({
  caseNumber: "27 Cdo 59/2022",
  country: "CZE",
  court: "Nejvyšší soud",
  decisionId: DECISION_ID,
  language: "cs",
  languageAlternates: [],
  slug: "27-cdo-59-2022",
});

const inspectorScope = {
  organizationId: MEMBER.activeOrganizationId,
  userId: MEMBER.id,
};

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
  await unregisterDomEnvironment();
});

/** What a member left behind: the decision's chat tab, with the pane folded. */
const persistDecisionChat = () => {
  writePersistedState(inspectorStateEntry, inspectorScope, {
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
        started: true,
        type: "chat",
      },
    ],
  }).unwrap();
  writePersistedState(inspectorMinimizedEntry, inspectorScope, true).unwrap();
};

const rootRoute = createRootRoute();
const router = createRouter({
  history: createMemoryHistory({ initialEntries: [DECISION_HREF] }),
  routeTree: rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: "/auth" }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/law/$country/cases/$court/$slug",
    }),
  ]),
});

/** The public law shell's inspector, as a signed-in member gets it. */
const renderMemberInspector = (client: QueryClient) =>
  render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={en} timeZone="UTC">
        <RouterContextProvider router={router}>
          <SidebarProvider defaultOpen>
            <AuthenticatedUserProvider user={MEMBER}>
              <PublicLawInspector />
            </AuthenticatedUserProvider>
          </SidebarProvider>
        </RouterContextProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );

/**
 * The decision page's own seeding, in its order: the details tab, then the
 * decision's chat as a reader whose conversation the server could not name
 * opens it. Without the restore, that chat would land on a fresh thread
 * nobody has written in, beside nothing the member left behind.
 */
const openDecisionPage = () => {
  const store = useInspectorTabsStore.getState();
  store.openView({
    ...DETAILS_TAB,
    ownerRouteId: "/law/$country/cases/$court/$slug",
    pane: INSPECTOR_PANE_INTENT.keep,
  });
  store.openChat({
    activeLegalKey: decisionChatKey(DECISION_ID),
    pane: INSPECTOR_PANE_INTENT.keep,
  });
};

describe("a member returning to a decision on the public law surface", () => {
  test("keeps the pane open when navigation remounts member persistence", () => {
    const client = new QueryClient();
    uninstallStorage = installUserScopedStorage(client);
    act(() => {
      client.setQueryData(rootKeys.session, { user: { id: MEMBER.id } });
    });
    persistDecisionChat();
    writePersistedState(
      inspectorMinimizedEntry,
      inspectorScope,
      false,
    ).unwrap();

    const firstShell = renderMemberInspector(client);
    expect(useInspectorTabsStore.getState().minimized).toBe(false);
    expect(
      readPersistedState(inspectorRestorePendingEntry, inspectorScope),
    ).not.toBe("");
    firstShell.unmount();
    renderMemberInspector(client);

    expect(useInspectorTabsStore.getState().minimized).toBe(false);
    expect(useInspectorTabsStore.getState().activeId).toBe(SAVED_THREAD_ID);
  });

  test("continues the decision's saved chat beside the page's own tabs", () => {
    const client = new QueryClient();
    uninstallStorage = installUserScopedStorage(client);
    act(() => {
      client.setQueryData(rootKeys.session, { user: { id: MEMBER.id } });
    });
    persistDecisionChat();

    renderMemberInspector(client);
    act(openDecisionPage);

    const { activeId, minimized, tabs } = useInspectorTabsStore.getState();
    const chats = tabs.filter((tab) => tab.type === "chat");
    // The saved conversation, not a fresh thread minted for the page.
    expect(chats.map((tab) => tab.id)).toEqual([SAVED_THREAD_ID]);
    expect(activeId).toBe(SAVED_THREAD_ID);
    // The page's details tab sits beside it, and the pane stays as the
    // member left it.
    expect(tabs.map((tab) => tab.id)).toContain(DETAILS_TAB.id);
    expect(minimized).toBe(true);
  });
});
