import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";
import { createStore } from "zustand";
import { immer } from "zustand/middleware/immer";

import type { InspectorTabsStore } from "@/components/inspector/inspector-store-types";
import messages from "@/i18n/langs/en.json";
import type { api } from "@/lib/api";

type PlaybookDetailData = Exclude<
  NonNullable<
    Extract<
      Awaited<ReturnType<ReturnType<typeof api.playbooks>["get"]>>,
      { data: unknown }
    >["data"]
  >,
  Response
>;

const PLAYBOOK_ID = "00000000-0000-4000-8000-000000000513";
const ORGANIZATION_ID = "editor-lifecycle-organization";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
const originalFetch = globalThis.fetch;
const putBodies: string[] = [];
let saveResult: "failed" | "saved" = "failed";
let deleteRequests = 0;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const address = input instanceof Request ? input.url : String(input);
    const url = new URL(address, "http://localhost:3000");
    const requestMethod = input instanceof Request ? input.method : "GET";
    const method = init?.method ?? requestMethod;
    if (
      url.pathname.endsWith(`/playbooks/${PLAYBOOK_ID}`) &&
      method === "PUT"
    ) {
      let body = "";
      if (typeof init?.body === "string") {
        body = init.body;
      } else if (input instanceof Request) {
        body = await input.clone().text();
      }
      putBodies.push(body);
      if (saveResult === "saved") {
        const saved = {
          updatedAt: "2026-10-08T08:01:00.000Z",
        } satisfies NonNullable<
          Extract<
            Awaited<ReturnType<ReturnType<typeof api.playbooks>["put"]>>,
            { data: unknown }
          >["data"]
        >;
        return Response.json(saved);
      }
      return Response.json({ message: "Save unavailable" }, { status: 503 });
    }
    if (
      url.pathname.endsWith(`/playbooks/${PLAYBOOK_ID}`) &&
      method === "DELETE"
    ) {
      deleteRequests += 1;
      return Response.json({});
    }
    return Response.json(
      { message: "Unexpected request in editor lifecycle test" },
      { status: 500 },
    );
  },
  { preconnect: () => undefined },
);

const { cleanup, fireEvent, render, act, waitFor } =
  await import("@testing-library/react");
const { createRootRoute, createRouter, createBrowserHistory, RouterProvider } =
  await import("@tanstack/react-router");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { useStore } = await import("zustand");
const { createInspectorTabsSlice } =
  await import("@/components/inspector/inspector-tabs-slice");
const { roleOptions } = await import("@/lib/auth-queries");
const { playbookDetailOptions, documentTypesOptions } =
  await import("@/lib/knowledge/queries");
const { PlaybookEditor } = await import("./playbook-editor");
const { PlaybookPaneLeaveConfirmation } =
  await import("./playbook-pane-leave-confirmation");
const {
  discardParkedPlaybookPane,
  readParkedPlaybookPane,
  cancelPlaybookPaneLeave,
  usePlaybookPaneLeave,
} = await import("./playbook-pane-parking");
const { PLAYBOOK_DRAFT_VIEW } =
  await import("@/lib/knowledge/playbook-draft-view");
const { hasUnsavedWork } = await import("@/hooks/use-unsaved-work");
await import("./playbook-draft-view-registration");

const cleanups: (() => void)[] = [];

const detail = (status: PlaybookDetailData["status"]) =>
  ({
    id: PLAYBOOK_ID,
    name: "Saved playbook",
    description: "Saved description",
    scope: null,
    positions: { version: 3, items: [] },
    status,
    approvedAt: status === "approved" ? "2026-10-08T08:00:00.000Z" : null,
    createdAt: "2026-10-08T08:00:00.000Z",
    updatedAt: "2026-10-08T08:00:00.000Z",
    positionDecisions: {},
    positionSources: [],
  }) as const satisfies PlaybookDetailData;

const mountEditor = async (status: PlaybookDetailData["status"]) => {
  const tabId = `lifecycle-${status}`;
  const client = new QueryClient({
    defaultOptions: {
      queries: { enabled: false, retry: false, gcTime: Infinity },
    },
  });
  client.setQueryData(roleOptions.queryKey, "owner");
  client.setQueryData(
    playbookDetailOptions(ORGANIZATION_ID, PLAYBOOK_ID).queryKey,
    detail(status),
  );
  client.setQueryData(documentTypesOptions(ORGANIZATION_ID).queryKey, {
    items: [],
  });
  const store = createStore<InspectorTabsStore>()(
    immer((set, get) => createInspectorTabsSlice(set, get)),
  );
  store.getState().openView({
    id: tabId,
    type: PLAYBOOK_DRAFT_VIEW,
    label: detail(status).name,
    payload: { type: "playbook", playbookId: PLAYBOOK_ID },
  });
  const EditorShell = () => {
    const visible = useStore(
      store,
      (state) => !state.minimized && state.tabs.some((tab) => tab.id === tabId),
    );
    return (
      <>
        <PlaybookPaneLeaveConfirmation />
        {visible && (
          <PlaybookEditor
            organizationId={ORGANIZATION_ID}
            playbookId={PLAYBOOK_ID}
            host={{
              type: "pane",
              tabId,
              isTabOpen: (id) =>
                store.getState().tabs.some((tab) => tab.id === id),
              onClose: () => store.getState().closeTab(tabId),
            }}
          />
        )}
      </>
    );
  };
  const root = createRootRoute({ component: EditorShell });
  const history = createBrowserHistory();
  const router = createRouter({ routeTree: root, history });
  await router.load();
  const view = render(
    <IntlProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </IntlProvider>,
  );
  cleanups.push(() => {
    discardParkedPlaybookPane(tabId);
    client.clear();
    history.destroy();
  });
  await waitFor(() =>
    expect(view.getByDisplayValue(detail(status).name)).toBeDefined(),
  );
  return { view, store, tabId };
};

afterEach(async () => {
  cleanup();
  await act(async () => {
    await Promise.resolve();
  });
  for (const dispose of cleanups.splice(0)) {
    dispose();
  }
  cancelPlaybookPaneLeave();
  putBodies.length = 0;
  saveResult = "failed";
  deleteRequests = 0;
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await GlobalRegistrator.unregister();
});

test("a failed real editor autosave and failed close-save keep the tab and its draft recoverable", async () => {
  const { view, store, tabId } = await mountEditor("draft");
  const draftName = "Unsaved recoverable playbook";
  fireEvent.change(view.getByLabelText(messages.common.name), {
    target: { value: draftName },
  });
  await waitFor(() => expect(putBodies).toHaveLength(1), { timeout: 5000 });
  await waitFor(() =>
    expect(
      view.getByText(messages.knowledge.playbooks.autosave.failed),
    ).toBeDefined(),
  );
  await act(async () => {
    store.getState().closeTab(tabId);
  });
  expect(store.getState().tabs).toHaveLength(1);
  expect(usePlaybookPaneLeave.getState()).toMatchObject({
    type: "confirm",
    leaveState: "save-failed",
  });
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", { name: messages.common.save, exact: true }),
    );
  });
  await waitFor(() => expect(putBodies).toHaveLength(2));
  await waitFor(() =>
    expect(usePlaybookPaneLeave.getState()).toMatchObject({
      type: "confirm",
      phase: "ready",
    }),
  );
  expect(store.getState().tabs.map((tab) => tab.id)).toEqual([tabId]);
  expect(view.getByDisplayValue(draftName)).toBeDefined();
  expect(readParkedPlaybookPane(tabId, PLAYBOOK_ID)).toMatchObject({
    draft: { name: draftName },
    leaveState: "save-failed",
  });
  expect(putBodies.every((body) => body.includes(draftName))).toBe(true);
});

test("a real approved editor parks unsaved edits on hide and the global owner keeps the beforeunload prompt", async () => {
  const { view, store, tabId } = await mountEditor("approved");
  const draftName = "Unsaved approved-playbook edit";
  fireEvent.change(view.getByLabelText(messages.common.name), {
    target: { value: draftName },
  });
  await waitFor(() => expect(hasUnsavedWork()).toBe(true));
  const beforeHide = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(beforeHide);
  expect(beforeHide.defaultPrevented).toBe(true);
  await act(async () => {
    store.getState().setMinimized(true);
  });
  expect(view.queryByLabelText(messages.common.name)).toBeNull();
  await waitFor(() =>
    expect(readParkedPlaybookPane(tabId, PLAYBOOK_ID)).toMatchObject({
      draft: { name: draftName },
      leaveState: "dirty-unsaveable",
    }),
  );
  expect(hasUnsavedWork()).toBe(true);
  const afterHide = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(afterHide);
  expect(afterHide.defaultPrevented).toBe(true);
  expect(putBodies).toHaveLength(0);
});

test("deleting an edited real draft before autosave closes the tab without parking or another save", async () => {
  const { view, store, tabId } = await mountEditor("draft");
  fireEvent.change(view.getByLabelText(messages.common.name), {
    target: { value: "Draft being deleted" },
  });
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", {
        name: messages.knowledge.playbooks.deletePlaybook,
      }),
    );
  });
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", { name: messages.common.delete, exact: true }),
    );
  });
  await waitFor(() => expect(store.getState().tabs).toHaveLength(0));
  expect(deleteRequests).toBe(1);
  expect(putBodies).toHaveLength(0);
  expect(usePlaybookPaneLeave.getState()).toEqual({ type: "idle" });
  expect(readParkedPlaybookPane(tabId, PLAYBOOK_ID)).toBeNull();
  await waitFor(() => expect(hasUnsavedWork()).toBe(false));
  expect(view.queryByRole("alertdialog")).toBeNull();
});

test("saving a reopened approved editor clears parked and global unload guards", async () => {
  const { view, store, tabId } = await mountEditor("approved");
  const draftName = "Approved edit to save after reopening";
  fireEvent.change(view.getByLabelText(messages.common.name), {
    target: { value: draftName },
  });
  await act(async () => {
    store.getState().setMinimized(true);
  });
  await waitFor(() =>
    expect(readParkedPlaybookPane(tabId, PLAYBOOK_ID)).toMatchObject({
      draft: { name: draftName },
      leaveState: "dirty-unsaveable",
    }),
  );
  expect(hasUnsavedWork()).toBe(true);
  await act(async () => {
    store.getState().setMinimized(false);
  });
  await waitFor(() => expect(view.getByDisplayValue(draftName)).toBeDefined());
  saveResult = "saved";
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", { name: messages.common.save, exact: true }),
    );
  });
  await waitFor(() => expect(putBodies).toHaveLength(1));
  await waitFor(() => expect(hasUnsavedWork()).toBe(false));
  expect(view.getByDisplayValue(draftName)).toBeDefined();
  expect(readParkedPlaybookPane(tabId, PLAYBOOK_ID)).toBeNull();
  const afterSave = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(afterSave);
  expect(afterSave.defaultPrevented).toBe(false);
  expect(store.getState().tabs.map((tab) => tab.id)).toEqual([tabId]);
});
