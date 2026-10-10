import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test, jest } from "bun:test";
import fc from "fast-check";
import { createStore } from "zustand";
import { immer } from "zustand/middleware/immer";

import { API_VERSION_CONFLICT_ERROR_CODE } from "@stll/api-contract";
import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import type { InspectorTabsStore } from "@/components/inspector/inspector-store-types";
import messages from "@/i18n/langs/en.json";
import type { api } from "@/lib/api";
import { unregisterDomEnvironment } from "@/test-dom-environment";

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
const nativeSetImmediate = setImmediate;
const putBodies: string[] = [];
let saveResult: "failed" | "saved" = "failed";
let deleteRequests = 0;
let fixtureDetail: PlaybookDetailData | null = null;
let fixtureReadCount = 0;
let propertyBackend: PropertyBackend | null = null;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const address = input instanceof Request ? input.url : String(input);
    const url = new URL(address, "http://localhost:3000");
    const requestMethod = input instanceof Request ? input.method : "GET";
    const method = init?.method ?? requestMethod;
    if (propertyBackend !== null) {
      return await handlePropertyRequest({
        backend: propertyBackend,
        url,
        method,
        input,
        init,
      });
    }
    if (
      url.pathname.endsWith(`/playbooks/${PLAYBOOK_ID}`) &&
      method === "GET" &&
      fixtureDetail !== null
    ) {
      fixtureReadCount += 1;
      return Response.json(fixtureDetail);
    }
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
        if (fixtureDetail !== null) {
          fixtureDetail = {
            ...fixtureDetail,
            ...readPropertyBody(body).fields,
            status: "draft",
            approvedAt: null,
            updatedAt: saved.updatedAt,
          };
        }
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
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { useStore } = await import("zustand");
const { createInspectorTabsSlice } =
  await import("@/components/inspector/inspector-tabs-slice");
const { roleOptions } = await import("@/lib/auth-queries");
const { toSafeId } = await import("@/lib/safe-id");
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
const { PLAYBOOK_DRAFT_VIEW, isPlaybookDraftViewPayload } =
  await import("@/lib/knowledge/playbook-draft-view");
const { hasUnsavedWork } = await import("@/hooks/use-unsaved-work");
const { followReconciledPlaybookSave } =
  await import("@/features/chat/hooks/use-chat-session-playbook-save.logic");
await import("./playbook-draft-view-registration");

const cleanups: (() => void)[] = [];

const detail = (status: PlaybookDetailData["status"]) =>
  ({
    id: toSafeId<"playbookDefinition">(PLAYBOOK_ID),
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
  }) satisfies PlaybookDetailData;

const mountEditor = async (
  status: PlaybookDetailData["status"],
  hostMode: "pane" | "page" = "pane",
) => {
  fixtureDetail = detail(status);
  const tabId = `lifecycle-${status}`;
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        enabled: propertyBackend !== null,
        retry: false,
        gcTime: Infinity,
        staleTime: Infinity,
      },
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
    const selected = useStore(store, (state) =>
      state.minimized ? undefined : state.tabs.find((tab) => tab.id === tabId),
    );
    const payload =
      selected?.type === "view" && isPlaybookDraftViewPayload(selected.payload)
        ? selected.payload
        : null;
    return (
      <>
        <PlaybookPaneLeaveConfirmation />
        {payload !== null && (
          <PlaybookEditor
            organizationId={ORGANIZATION_ID}
            key={payload.playbookId}
            playbookId={payload.playbookId}
            host={
              hostMode === "page"
                ? {
                    type: "page",
                    onBack: () => store.getState().closeTab(tabId),
                    onSaved: () => undefined,
                    tourAnchors: {
                      back: () => ({}),
                      basics: {},
                      addPosition: {},
                    },
                  }
                : {
                    type: "pane",
                    tabId,
                    isTabOpen: (id) =>
                      store.getState().tabs.some((tab) => tab.id === id),
                    onClose: () => store.getState().closeTab(tabId),
                  }
            }
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
      <FormattingProvider locale="en" timeZone="UTC">
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </FormattingProvider>
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
  return { view, store, tabId, client };
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
  fixtureDetail = null;
  fixtureReadCount = 0;
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
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
    fireEvent.click(view.getByRole("button", { name: messages.common.save }));
  });
  await waitFor(() => expect(putBodies).toHaveLength(2));
  await waitFor(() =>
    expect(usePlaybookPaneLeave.getState()).toMatchObject({
      type: "confirm",
      phase: "ready",
    }),
  );
  expect(fixtureReadCount).toBeGreaterThan(0);
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
    fireEvent.click(view.getByRole("button", { name: messages.common.delete }));
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
    fireEvent.click(view.getByRole("button", { name: messages.common.save }));
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

type LifecycleFields = { name: string; description: string };
type LifecycleSaveResult = "saved" | "failed" | "rejected";
type LifecycleWrite = {
  fields: LifecycleFields;
  expectedVersion: number;
  purpose: "persist" | "park" | "close";
  committedVersion: number | null;
};
type LifecycleModel = {
  mode: "open" | "opening" | "hidden" | "closed" | "deleted";
  status: PlaybookDetailData["status"];
  draft: LifecycleFields;
  baseline: LifecycleFields;
  baselineVersion: number;
  server: LifecycleFields;
  serverVersion: number;
  observedServer: LifecycleFields;
  observedVersion: number;
  clock: number;
  saveFailed: boolean;
  confirmation: "none" | "waiting" | "discard" | "retry";
  pending: LifecycleWrite[];
  unacknowledged: LifecycleFields[];
  steps: number;
};
type PropertyRequest = {
  playbookId: string;
  fields: LifecycleFields;
  expectedUpdatedAt: string;
  response: ReturnType<typeof Promise.withResolvers<Response>>;
  committedVersion: number | null;
};
type PropertyBackend = {
  clock: number;
  rows: Map<string, PlaybookDetailData>;
  pending: PropertyRequest[];
  putCount: number;
  missingMethods: string[];
  reads: { playbookId: string; fields: LifecycleFields; updatedAt: string }[];
  writes: {
    fields: LifecycleFields;
    expectedUpdatedAt: string;
    updatedAt: string;
  }[];
};
type LifecycleReal = Awaited<ReturnType<typeof mountEditor>> & {
  backend: PropertyBackend;
};
const OTHER_PLAYBOOK_ID = "00000000-0000-4000-8000-000000000514";
const versionToken = (version: number) =>
  new Date(Date.UTC(2026, 9, 8, 8, 0, version)).toISOString();

const readPropertyBody = (body: string) => {
  const payload: unknown = JSON.parse(body);
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("name" in payload) ||
    typeof payload.name !== "string" ||
    !("expectedUpdatedAt" in payload) ||
    typeof payload.expectedUpdatedAt !== "string"
  ) {
    throw new TypeError(
      "A playbook update must include a name and concurrency token",
    );
  }
  const description =
    "description" in payload && typeof payload.description === "string"
      ? payload.description
      : "";
  return {
    fields: { name: payload.name, description },
    expectedUpdatedAt: payload.expectedUpdatedAt,
  };
};

type PropertyRequestOptions = {
  backend: PropertyBackend;
  url: URL;
  method: string;
  input: RequestInfo | URL;
  init: RequestInit | undefined;
};
const handlePropertyRequest = async ({
  backend,
  url,
  method,
  input,
  init,
}: PropertyRequestOptions) => {
  const playbookId = url.pathname.split("/").at(-1) ?? "";
  const row = backend.rows.get(playbookId);
  if (method === "PUT") {
    backend.putCount += 1;
  }
  if (row === undefined) {
    backend.missingMethods.push(method);
    return Response.json({ message: "Playbook not found" }, { status: 404 });
  }
  if (method === "GET") {
    backend.reads.push({
      playbookId,
      fields: { name: row.name, description: row.description ?? "" },
      updatedAt: row.updatedAt,
    });
    return Response.json(row);
  }
  if (method === "DELETE") {
    backend.rows.delete(playbookId);
    return Response.json({});
  }
  if (method !== "PUT") {
    return Response.json(
      { message: "Unexpected model-test request" },
      { status: 404 },
    );
  }
  let body = "";
  if (typeof init?.body === "string") {
    body = init.body;
  } else if (input instanceof Request) {
    body = await input.clone().text();
  }
  const response = Promise.withResolvers<Response>();
  backend.pending.push({
    playbookId,
    ...readPropertyBody(body),
    response,
    committedVersion: null,
  });
  return await response.promise;
};

const lifecycleDirty = (model: Readonly<LifecycleModel>) =>
  model.draft.name !== model.baseline.name ||
  model.draft.description !== model.baseline.description ||
  (model.unacknowledged.length > 0 &&
    (model.draft.name !== model.server.name ||
      model.draft.description !== model.server.description));
const settleLifecycle = async () => {
  await act(async () => {
    await Promise.resolve();
    jest.advanceTimersByTime(0);
    await new Promise<void>((resolve) => {
      nativeSetImmediate(resolve);
    });
    jest.advanceTimersByTime(0);
  });
};
const editLifecycleField = async (
  real: LifecycleReal,
  field: keyof LifecycleFields,
  value: string,
) => {
  await act(async () => {
    fireEvent.change(real.view.getByLabelText(messages.common[field]), {
      target: { value },
    });
  });
};
const adoptLifecycleServer = (model: LifecycleModel) => {
  if (model.observedVersion <= model.baselineVersion) {
    return;
  }
  const local = model.draft;
  const keepName =
    local.name !== model.baseline.name ||
    model.unacknowledged.some((submitted) => submitted.name !== local.name);
  const keepDescription =
    local.description !== model.baseline.description ||
    model.unacknowledged.some(
      (submitted) => submitted.description !== local.description,
    );
  model.draft = {
    name: keepName ? local.name : model.observedServer.name,
    description: keepDescription
      ? local.description
      : model.observedServer.description,
  };
  model.unacknowledged = [];
  model.baseline = { ...model.observedServer };
  model.baselineVersion = model.observedVersion;
  model.status = "draft";
};

const assertLifecycleOracle = async (
  model: Readonly<LifecycleModel>,
  real: LifecycleReal,
) => {
  await settleLifecycle();
  const tabs = real.store.getState().tabs;
  if (model.mode === "closed" || model.mode === "deleted") {
    expect(tabs.some((tab) => tab.id === real.tabId)).toBe(false);
    expect(readParkedPlaybookPane(real.tabId, PLAYBOOK_ID)).toBeNull();
  } else {
    expect(tabs.some((tab) => tab.id === real.tabId)).toBe(true);
  }
  if (model.mode === "open") {
    const name = real.view.getByLabelText(messages.common.name);
    const description = real.view.getByLabelText(messages.common.description);
    if (
      !(name instanceof HTMLInputElement) ||
      !(description instanceof HTMLTextAreaElement)
    ) {
      throw new TypeError(
        "The real playbook editor must expose both editable fields",
      );
    }
    expect(name.value).toBe(model.draft.name);
    expect(description.value).toBe(model.draft.description);
  }
  if (model.mode === "hidden" || model.mode === "opening") {
    expect(real.view.queryByLabelText(messages.common.name)).toBeNull();
    const parked = readParkedPlaybookPane(real.tabId, PLAYBOOK_ID);
    if (lifecycleDirty(model) || model.pending.length > 0) {
      expect(parked?.draft.name).toBe(model.draft.name);
      expect(parked?.draft.description).toBe(model.draft.description);
    }
  }
  const unsaved =
    (model.mode === "open" ||
      model.mode === "opening" ||
      model.mode === "hidden") &&
    (lifecycleDirty(model) || model.pending.length > 0);
  expect(hasUnsavedWork()).toBe(unsaved);
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(unsaved);
  const leave = usePlaybookPaneLeave.getState();
  switch (model.confirmation) {
    case "none":
      expect(leave.type).toBe("idle");
      break;
    case "discard":
      expect(leave).toMatchObject({
        type: "confirm",
        leaveState: "dirty-unsaveable",
        phase: "ready",
      });
      break;
    case "retry":
      expect(leave).toMatchObject({
        type: "confirm",
        leaveState: "save-failed",
        phase: "ready",
      });
      break;
    case "waiting":
      expect(
        leave.type === "waiting" ||
          (leave.type === "confirm" && leave.phase === "saving"),
      ).toBe(true);
      break;
    default: {
      const exhaustive: never = model.confirmation;
      throw new TypeError(String(exhaustive));
    }
  }
  const row = real.backend.rows.get(PLAYBOOK_ID);
  if (model.mode !== "deleted") {
    expect(row?.name).toBe(model.server.name);
    expect(row?.description ?? "").toBe(model.server.description);
    expect(row?.updatedAt).toBe(versionToken(model.serverVersion));
  }
};

const startLifecycleSave = async (
  model: LifecycleModel,
  real: LifecycleReal,
  purpose: LifecycleWrite["purpose"] = "persist",
) => {
  model.unacknowledged.push({ ...model.draft });
  model.pending.push({
    fields: { ...model.draft },
    expectedVersion: model.baselineVersion,
    purpose,
    committedVersion: null,
  });
  if (model.saveFailed) {
    await act(async () => {
      fireEvent.click(
        real.view.getByRole("button", { name: messages.common.retry }),
      );
    });
  } else if (model.status === "approved") {
    await act(async () => {
      fireEvent.click(
        real.view.getByRole("button", { name: messages.common.save }),
      );
    });
  } else {
    await act(async () => {
      jest.advanceTimersByTime(2100);
    });
  }
  await settleLifecycle();
};

const commitLifecycleSave = async (
  model: LifecycleModel,
  real: LifecycleReal,
) => {
  const expected = model.pending.at(0);
  const request = real.backend.pending.at(0);
  if (expected === undefined || request === undefined) {
    throw new TypeError(
      "Committing a save requires a queued snapshot and a real request",
    );
  }
  expect(request.fields).toEqual(expected.fields);
  expect(request.expectedUpdatedAt).toBe(
    versionToken(expected.expectedVersion),
  );
  if (
    expected.committedVersion !== null ||
    expected.expectedVersion !== model.serverVersion
  ) {
    throw new TypeError(
      "Only an uncommitted request with the current server token can commit",
    );
  }
  const row = real.backend.rows.get(request.playbookId);
  if (row === undefined) {
    throw new TypeError("Committing a save requires an existing playbook");
  }
  model.clock += 1;
  real.backend.clock += 1;
  expected.committedVersion = model.clock;
  request.committedVersion = real.backend.clock;
  model.server = { ...expected.fields };
  model.serverVersion = model.clock;
  const updatedAt = versionToken(real.backend.clock);
  const updated = {
    ...row,
    ...request.fields,
    status: "draft",
    approvedAt: null,
    updatedAt,
  } as const satisfies PlaybookDetailData;
  real.backend.rows.set(request.playbookId, updated);
  real.backend.writes.push({
    fields: { ...request.fields },
    expectedUpdatedAt: request.expectedUpdatedAt,
    updatedAt,
  });
};

const refetchLifecycle = async (model: LifecycleModel, real: LifecycleReal) => {
  const row = real.backend.rows.get(PLAYBOOK_ID);
  if (row === undefined) {
    throw new TypeError("Refetching requires an existing playbook");
  }
  model.observedServer = { ...model.server };
  model.observedVersion = model.serverVersion;
  await act(async () => {
    real.client.setQueryData(
      playbookDetailOptions(ORGANIZATION_ID, PLAYBOOK_ID).queryKey,
      row,
    );
  });
  if (model.mode === "open" && model.pending.length === 0) {
    adoptLifecycleServer(model);
  }
  if (
    model.pending.length === 0 &&
    model.observedVersion === model.baselineVersion
  ) {
    model.unacknowledged = [];
  }
};

const completeLifecycleSave = async (
  model: LifecycleModel,
  real: LifecycleReal,
  result: LifecycleSaveResult,
) => {
  const queued = model.pending.at(0);
  if (queued === undefined) {
    throw new TypeError("Completing a save requires a queued snapshot");
  }
  if (
    queued.committedVersion === null &&
    result === "saved" &&
    queued.expectedVersion === model.serverVersion
  ) {
    await commitLifecycleSave(model, real);
  }
  const expected = model.pending.shift();
  const request = real.backend.pending.shift();
  if (expected === undefined || request === undefined) {
    throw new TypeError(
      "Completing a save requires both a snapshot and a real request",
    );
  }
  expect(request.fields).toEqual(expected.fields);
  expect(request.expectedUpdatedAt).toBe(
    versionToken(expected.expectedVersion),
  );
  const saved = result === "saved" && expected.committedVersion !== null;
  const conflict =
    expected.committedVersion === null &&
    expected.expectedVersion !== model.serverVersion;
  let response: Response;
  if (saved && expected.committedVersion !== null) {
    const savedVersion = expected.committedVersion;
    response = Response.json({ updatedAt: versionToken(savedVersion) });
    if (savedVersion >= model.baselineVersion) {
      model.baseline = { ...expected.fields };
      model.baselineVersion = savedVersion;
    }
    model.status = "draft";
    model.unacknowledged = model.pending.map((pending) => ({
      ...pending.fields,
    }));
    const next = model.pending.at(0);
    if (next !== undefined) {
      next.expectedVersion = savedVersion;
    }
  } else {
    response = Response.json(
      {
        ...(conflict ? { code: API_VERSION_CONFLICT_ERROR_CODE } : {}),
        message: conflict ? "Playbook changed" : "Save unavailable",
      },
      { status: conflict ? 409 : 503 },
    );
  }
  const readsBeforeResponse = real.backend.reads.length;
  const modeBeforeResponse = model.mode;
  await act(async () => {
    if (result === "rejected") {
      request.response.reject(new TypeError("Network request rejected"));
    } else {
      request.response.resolve(response);
    }
  });
  await settleLifecycle();
  const observedRead = real.backend.reads
    .slice(readsBeforeResponse)
    .findLast((read) => read.playbookId === PLAYBOOK_ID);
  if (observedRead !== undefined) {
    expect(observedRead.fields).toEqual(model.server);
    expect(observedRead.updatedAt).toBe(versionToken(model.serverVersion));
    model.observedServer = { ...model.server };
    model.observedVersion = model.serverVersion;
  }
  if (model.pending.length > 0) {
    return;
  }
  model.saveFailed = !saved;
  if (
    !saved &&
    (modeBeforeResponse === "open" ||
      modeBeforeResponse === "hidden" ||
      modeBeforeResponse === "opening")
  ) {
    // A failed reply cannot settle persistence uncertainty from an old cached read.
    expect(observedRead).toBeDefined();
  }
  if (
    model.mode === "open" ||
    model.mode === "opening" ||
    (!saved && model.mode === "hidden")
  ) {
    adoptLifecycleServer(model);
    if (
      observedRead !== undefined &&
      model.observedVersion === model.baselineVersion
    ) {
      model.unacknowledged = [];
    }
  }
  if (model.mode === "opening") {
    model.mode = "open";
    if (!lifecycleDirty(model)) {
      model.saveFailed = false;
    }
  }
  if (expected.purpose === "close") {
    if (saved || (model.mode === "hidden" && !lifecycleDirty(model))) {
      model.mode = "closed";
      model.confirmation = "none";
    } else {
      model.confirmation = "retry";
    }
  }
};

type LifecycleAction =
  | { type: "edit"; field: keyof LifecycleFields; value: string }
  | { type: "save" }
  | { type: "complete"; result: LifecycleSaveResult }
  | { type: "commit" }
  | { type: "refetch" }
  | { type: "revert" }
  | { type: "hide" }
  | { type: "open" }
  | { type: "close" }
  | { type: "answer"; answer: "cancel" | "confirm" }
  | { type: "server-edit"; field: keyof LifecycleFields; value: string }
  | { type: "other-playbook" }
  | { type: "delete" }
  | { type: "unload" }
  | { type: "persistent-failure"; intervals: number };

const hideLifecycle = async (model: LifecycleModel, real: LifecycleReal) => {
  if (
    model.status === "draft" &&
    (lifecycleDirty(model) || model.pending.length > 0)
  ) {
    model.unacknowledged.push({ ...model.draft });
    model.pending.push({
      fields: { ...model.draft },
      expectedVersion: model.baselineVersion,
      purpose: "park",
      committedVersion: null,
    });
  }
  model.mode = "hidden";
  await act(async () => {
    real.store.getState().setMinimized(true);
  });
};
const openLifecycle = async (model: LifecycleModel, real: LifecycleReal) => {
  model.observedServer = { ...model.server };
  model.observedVersion = model.serverVersion;
  if (model.mode === "hidden" && model.pending.length > 0) {
    model.mode = "opening";
    await act(async () => {
      real.store.getState().setMinimized(false);
    });
    return;
  }
  if (model.mode === "closed") {
    model.draft = { ...model.server };
    model.baseline = { ...model.server };
    model.baselineVersion = model.serverVersion;
    model.saveFailed = false;
    model.unacknowledged = [];
    real.client.setQueryData(
      playbookDetailOptions(ORGANIZATION_ID, PLAYBOOK_ID).queryKey,
      real.backend.rows.get(PLAYBOOK_ID),
    );
    await act(async () => {
      real.store.getState().openView({
        id: real.tabId,
        type: PLAYBOOK_DRAFT_VIEW,
        label: model.server.name,
        payload: { type: "playbook", playbookId: PLAYBOOK_ID },
      });
    });
  }
  adoptLifecycleServer(model);
  if (model.observedVersion === model.baselineVersion) {
    model.unacknowledged = [];
  }
  if (!lifecycleDirty(model)) {
    model.saveFailed = false;
  }
  model.mode = "open";
  await act(async () => {
    real.store.getState().setMinimized(false);
  });
};
const serverEditLifecycle = async (
  model: LifecycleModel,
  real: LifecycleReal,
  fields: Partial<LifecycleFields>,
) => {
  model.clock += 1;
  model.serverVersion = model.clock;
  model.server = { ...model.server, ...fields };
  real.backend.clock += 1;
  const row = real.backend.rows.get(PLAYBOOK_ID);
  if (row === undefined) {
    throw new TypeError("A server edit requires an existing playbook");
  }
  const updated = {
    ...row,
    ...fields,
    status: "draft",
    approvedAt: null,
    updatedAt: versionToken(real.backend.clock),
  } as const satisfies PlaybookDetailData;
  real.backend.rows.set(PLAYBOOK_ID, updated);
  await act(async () => {
    real.client.setQueryData(
      playbookDetailOptions(ORGANIZATION_ID, PLAYBOOK_ID).queryKey,
      updated,
    );
  });
  model.observedServer = { ...model.server };
  model.observedVersion = model.serverVersion;
  if (model.mode === "open" && model.pending.length === 0) {
    adoptLifecycleServer(model);
  }
};
const closeLifecycle = async (model: LifecycleModel, real: LifecycleReal) => {
  const dirty = lifecycleDirty(model) || model.pending.length > 0;
  if (!dirty) {
    model.mode = "closed";
  } else if (model.saveFailed) {
    model.confirmation = "retry";
  } else if (model.status === "approved") {
    model.confirmation = "discard";
  } else if (model.mode === "open") {
    model.unacknowledged.push({ ...model.draft });
    model.pending.push({
      fields: { ...model.draft },
      expectedVersion: model.baselineVersion,
      purpose: "close",
      committedVersion: null,
    });
    model.confirmation = "waiting";
  } else {
    const final = model.pending.at(-1);
    if (final !== undefined) {
      final.purpose = "close";
    }
    model.confirmation = "waiting";
  }
  await act(async () => {
    real.store.getState().closeTab(real.tabId);
  });
};
const answerLifecycle = async (
  model: LifecycleModel,
  real: LifecycleReal,
  answer: "cancel" | "confirm",
) => {
  if (answer === "cancel") {
    model.confirmation = "none";
    await act(async () => {
      fireEvent.click(
        real.view.getByRole("button", {
          name: messages.common.goBackToEditing,
        }),
      );
    });
    return;
  }
  if (model.confirmation === "discard" || model.mode === "hidden") {
    model.mode = "closed";
    model.confirmation = "none";
    await act(async () => {
      fireEvent.click(
        real.view.getByRole("button", {
          name: messages.clauses.leaveAndDiscard,
        }),
      );
    });
    return;
  }
  const button = real.view.getByRole("button", { name: messages.common.save });
  if (lifecycleDirty(model) || model.pending.length > 0) {
    model.unacknowledged.push({ ...model.draft });
    model.pending.push({
      fields: { ...model.draft },
      expectedVersion: model.baselineVersion,
      purpose: "close",
      committedVersion: null,
    });
    model.confirmation = "waiting";
  }
  await act(async () => {
    fireEvent.click(button);
  });
};
const otherPlaybookLifecycle = async (
  model: LifecycleModel,
  real: LifecycleReal,
) => {
  const other = {
    ...detail("draft"),
    id: toSafeId<"playbookDefinition">(OTHER_PLAYBOOK_ID),
    name: "Other server playbook",
  } as const satisfies PlaybookDetailData;
  real.backend.rows.set(OTHER_PLAYBOOK_ID, other);
  real.client.setQueryData(
    playbookDetailOptions(ORGANIZATION_ID, OTHER_PLAYBOOK_ID).queryKey,
    other,
  );
  await act(async () => {
    await followReconciledPlaybookSave({
      reconciliation: {
        playbookId: OTHER_PLAYBOOK_ID,
        source: "live",
        refetched: Promise.resolve(),
      },
      isCurrent: () => true,
      follow: (playbookId) =>
        real.store.getState().updateView({
          id: real.tabId,
          label: other.name,
          payload: { type: "playbook", playbookId },
        }),
    });
  });
  // A model save requests a real retarget; cancelling explicitly keeps the user's pane.
  await act(async () => {
    fireEvent.click(
      real.view.getByRole("button", { name: messages.common.goBackToEditing }),
    );
  });
  const tab = real.store
    .getState()
    .tabs.find((entry) => entry.id === real.tabId);
  expect(tab?.type === "view" ? tab.payload : null).toEqual({
    type: "playbook",
    playbookId: PLAYBOOK_ID,
  });
  expect(model.draft).not.toEqual({
    name: other.name,
    description: other.description,
  });
};
const deleteLifecycle = async (model: LifecycleModel, real: LifecycleReal) => {
  await act(async () => {
    fireEvent.click(
      real.view.getByRole("button", {
        name: messages.knowledge.playbooks.deletePlaybook,
      }),
    );
  });
  await act(async () => {
    fireEvent.click(
      real.view.getByRole("button", { name: messages.common.delete }),
    );
  });
  model.mode = "deleted";
  model.confirmation = "none";
};

class LifecycleCommand implements fc.AsyncCommand<
  LifecycleModel,
  LifecycleReal
> {
  readonly action: LifecycleAction;

  constructor(action: LifecycleAction) {
    this.action = action;
  }

  check(model: Readonly<LifecycleModel>) {
    const idle = model.confirmation === "none";
    switch (this.action.type) {
      case "unload":
        return true;
      case "persistent-failure":
        return (
          idle &&
          model.mode === "open" &&
          model.saveFailed &&
          model.pending.length === 0
        );
      case "refetch":
        return (
          model.mode === "open" ||
          model.mode === "hidden" ||
          model.mode === "opening"
        );
      case "complete":
        return model.pending.length > 0;
      case "commit": {
        const pending = model.pending.at(0);
        return (
          pending?.committedVersion === null &&
          pending.expectedVersion === model.serverVersion
        );
      }
      case "answer":
        return (
          model.confirmation === "discard" || model.confirmation === "retry"
        );
      case "open":
        return (
          idle &&
          (model.mode === "hidden" ||
            (model.mode === "closed" && model.pending.length === 0))
        );
      case "edit":
      case "revert":
        return idle && model.mode === "open";
      case "save":
        return (
          idle &&
          model.mode === "open" &&
          lifecycleDirty(model) &&
          model.pending.length === 0
        );
      case "hide":
        return idle && model.mode === "open";
      case "close":
        return idle && (model.mode === "open" || model.mode === "hidden");
      case "server-edit":
        return idle && (model.mode === "open" || model.mode === "hidden");
      case "other-playbook":
        return (
          idle &&
          model.mode === "open" &&
          lifecycleDirty(model) &&
          model.pending.length === 0 &&
          (model.status === "approved" || model.saveFailed)
        );
      case "delete":
        return (
          idle &&
          model.mode === "open" &&
          lifecycleDirty(model) &&
          model.pending.length === 0 &&
          model.steps >= 8
        );
      default: {
        const exhaustive: never = this.action;
        return exhaustive;
      }
    }
  }

  async run(model: LifecycleModel, real: LifecycleReal) {
    model.steps += 1;
    const action = this.action;
    switch (action.type) {
      case "edit":
        model.saveFailed = false;
        model.draft = { ...model.draft, [action.field]: action.value };
        await editLifecycleField(real, action.field, action.value);
        break;
      case "revert":
        model.saveFailed = false;
        model.draft = { ...model.baseline };
        await editLifecycleField(real, "name", model.draft.name);
        await editLifecycleField(real, "description", model.draft.description);
        break;
      case "save":
        await startLifecycleSave(model, real);
        break;
      case "complete":
        await completeLifecycleSave(model, real, action.result);
        break;
      case "commit":
        await commitLifecycleSave(model, real);
        break;
      case "refetch":
        await refetchLifecycle(model, real);
        break;
      case "hide":
        await hideLifecycle(model, real);
        break;
      case "open":
        await openLifecycle(model, real);
        break;
      case "close":
        await closeLifecycle(model, real);
        break;
      case "answer":
        await answerLifecycle(model, real, action.answer);
        break;
      case "server-edit":
        await serverEditLifecycle(model, real, {
          [action.field]: action.value,
        });
        break;
      case "other-playbook":
        await otherPlaybookLifecycle(model, real);
        break;
      case "delete":
        await deleteLifecycle(model, real);
        break;
      case "unload":
        break;
      case "persistent-failure": {
        const attemptsBefore = real.backend.putCount;
        for (let interval = 0; interval < action.intervals; interval += 1) {
          await act(async () => {
            jest.advanceTimersByTime(2100);
          });
          await settleLifecycle();
          expect(real.backend.putCount).toBe(attemptsBefore);
          expect(real.backend.pending).toHaveLength(0);
        }
        break;
      }
      default: {
        const exhaustive: never = action;
        throw new TypeError(String(exhaustive));
      }
    }
    await assertLifecycleOracle(model, real);
  }

  toString() {
    return JSON.stringify(this.action);
  }
}

const disposeLifecycleFixture = async (real: LifecycleReal) => {
  await act(async () => {
    cancelPlaybookPaneLeave();
    real.view.unmount();
  });
  while (real.backend.pending.length > 0) {
    const pending = real.backend.pending.splice(0);
    await act(async () => {
      for (const request of pending) {
        request.response.resolve(
          Response.json({ message: "Trial disposed" }, { status: 503 }),
        );
      }
    });
    await settleLifecycle();
  }
  for (const dispose of cleanups.splice(0)) {
    dispose();
  }
  propertyBackend = null;
  jest.useRealTimers();
};

test("a failed page-host save becomes clean after reverting to freshly confirmed server values", async () => {
  const backend: PropertyBackend = {
    clock: 0,
    rows: new Map([[PLAYBOOK_ID, detail("draft")]]),
    pending: [],
    putCount: 0,
    missingMethods: [],
    reads: [],
    writes: [],
  };
  propertyBackend = backend;
  const mounted = await mountEditor("draft", "page");
  const real: LifecycleReal = { ...mounted, backend };
  jest.useFakeTimers();
  try {
    await editLifecycleField(real, "name", "Unpersisted page name");
    await editLifecycleField(
      real,
      "description",
      "Unpersisted page description",
    );
    expect(hasUnsavedWork()).toBe(true);
    await act(async () => {
      fireEvent.click(
        mounted.view.getByRole("button", { name: messages.common.save }),
      );
    });
    await settleLifecycle();
    const request = backend.pending.shift();
    if (request === undefined) {
      throw new TypeError("A page Save must send an actual request");
    }
    const readsBefore = backend.reads.length;
    await act(async () => {
      request.response.resolve(
        Response.json({ message: "Save unavailable" }, { status: 503 }),
      );
    });
    await settleLifecycle();
    expect(backend.reads.length).toBeGreaterThan(readsBefore);
    await editLifecycleField(real, "name", detail("draft").name);
    await editLifecycleField(real, "description", detail("draft").description);
    await settleLifecycle();
    expect(hasUnsavedWork()).toBe(false);
    expect(
      mounted.view.getByRole("button", { name: messages.common.save }),
    ).toHaveProperty("disabled", true);
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
    expect(backend.putCount).toBe(1);
  } finally {
    await disposeLifecycleFixture(real);
  }
});

test("a dirty real pane deleted elsewhere closes only after confirming discard and clears parking", async () => {
  const backend: PropertyBackend = {
    clock: 0,
    rows: new Map([[PLAYBOOK_ID, detail("draft")]]),
    pending: [],
    putCount: 0,
    missingMethods: [],
    reads: [],
    writes: [],
  };
  propertyBackend = backend;
  const mounted = await mountEditor("draft");
  const real: LifecycleReal = { ...mounted, backend };
  jest.useFakeTimers();
  try {
    const finalDraftName = "Deleted playbook draft to discard";
    await editLifecycleField(real, "name", finalDraftName);
    backend.rows.delete(PLAYBOOK_ID);
    await act(async () => {
      await mounted.client.refetchQueries({
        queryKey: playbookDetailOptions(ORGANIZATION_ID, PLAYBOOK_ID).queryKey,
        exact: true,
      });
    });
    await settleLifecycle();
    expect(
      mounted.view.getByText(messages.knowledge.playbooks.deletedElsewhere),
    ).toBeDefined();
    expect(backend.missingMethods).toContain("GET");
    expect(backend.missingMethods).toContain("PUT");
    expect(readParkedPlaybookPane(mounted.tabId, PLAYBOOK_ID)?.draft.name).toBe(
      finalDraftName,
    );
    await act(async () => {
      fireEvent.click(
        mounted.view.getByRole("button", { name: messages.common.close }),
      );
    });
    expect(usePlaybookPaneLeave.getState()).toMatchObject({
      type: "confirm",
      phase: "ready",
      leaveState: "save-failed",
    });
    expect(mounted.store.getState().tabs.map((tab) => tab.id)).toEqual([
      mounted.tabId,
    ]);
    await act(async () => {
      fireEvent.click(
        mounted.view.getByRole("button", {
          name: messages.common.goBackToEditing,
        }),
      );
    });
    expect(readParkedPlaybookPane(mounted.tabId, PLAYBOOK_ID)?.draft.name).toBe(
      finalDraftName,
    );
    await act(async () => {
      fireEvent.click(
        mounted.view.getByRole("button", { name: messages.common.close }),
      );
    });
    await act(async () => {
      fireEvent.click(
        mounted.view.getByRole("button", {
          name: messages.clauses.leaveAndDiscard,
        }),
      );
    });
    await settleLifecycle();
    expect(mounted.store.getState().tabs).toHaveLength(0);
    expect(readParkedPlaybookPane(mounted.tabId, PLAYBOOK_ID)).toBeNull();
    expect(hasUnsavedWork()).toBe(false);
  } finally {
    await disposeLifecycleFixture(real);
  }
});

test("a failing real editor autosave stays paused after successful verification until explicit Retry", async () => {
  const backend: PropertyBackend = {
    clock: 0,
    rows: new Map([[PLAYBOOK_ID, detail("draft")]]),
    pending: [],
    putCount: 0,
    missingMethods: [],
    reads: [],
    writes: [],
  };
  propertyBackend = backend;
  const mounted = await mountEditor("draft");
  const real: LifecycleReal = { ...mounted, backend };
  const failNextRequest = async () => {
    const request = backend.pending.shift();
    if (request === undefined) {
      throw new TypeError("A failed response requires a real pending request");
    }
    const readsBefore = backend.reads.length;
    await act(async () => {
      request.response.resolve(
        Response.json({ message: "Save unavailable" }, { status: 503 }),
      );
    });
    await settleLifecycle();
    expect(backend.reads.length).toBeGreaterThan(readsBefore);
  };
  const assertPaused = async (expectedAttempts: number) => {
    for (let interval = 0; interval < 4; interval += 1) {
      await act(async () => {
        jest.advanceTimersByTime(2100);
      });
      await settleLifecycle();
      expect(backend.putCount).toBe(expectedAttempts);
      expect(backend.pending).toHaveLength(0);
    }
  };
  jest.useFakeTimers();
  try {
    const draftName = "Recoverable paused autosave";
    await editLifecycleField(real, "name", draftName);
    await act(async () => {
      jest.advanceTimersByTime(2100);
    });
    await settleLifecycle();
    expect(backend.putCount).toBe(1);
    await failNextRequest();
    await assertPaused(1);
    expect(mounted.view.getByDisplayValue(draftName)).toBeDefined();
    await act(async () => {
      fireEvent.click(
        mounted.view.getByRole("button", { name: messages.common.retry }),
      );
    });
    await settleLifecycle();
    expect(backend.putCount).toBe(2);
    await failNextRequest();
    await assertPaused(2);
    expect(mounted.view.getByDisplayValue(draftName)).toBeDefined();
  } finally {
    await act(async () => {
      mounted.view.unmount();
    });
    while (backend.pending.length > 0) {
      const pending = backend.pending.splice(0);
      await act(async () => {
        for (const request of pending) {
          request.response.resolve(
            Response.json({ message: "Trial disposed" }, { status: 503 }),
          );
        }
      });
      await settleLifecycle();
    }
    for (const dispose of cleanups.splice(0)) {
      dispose();
    }
    propertyBackend = null;
    jest.useRealTimers();
  }
});

const lifecycleText = fc.stringMatching(/^[a-z][a-z0-9]{0,12}$/u);
const lifecycleCommandArbitraries = [
  fc
    .record({
      field: fc.constantFrom("name", "description"),
      value: lifecycleText,
    })
    .map(
      ({ field, value }) =>
        new LifecycleCommand({ type: "edit", field, value }),
    ),
  fc.constant(new LifecycleCommand({ type: "save" })),
  fc.constant(new LifecycleCommand({ type: "commit" })),
  fc.constant(new LifecycleCommand({ type: "refetch" })),
  fc
    .constantFrom("saved", "failed", "rejected")
    .map((result) => new LifecycleCommand({ type: "complete", result })),
  fc.constant(new LifecycleCommand({ type: "revert" })),
  fc.constant(new LifecycleCommand({ type: "hide" })),
  fc.constant(new LifecycleCommand({ type: "open" })),
  fc.constant(new LifecycleCommand({ type: "close" })),
  fc
    .constantFrom("cancel", "confirm")
    .map((answer) => new LifecycleCommand({ type: "answer", answer })),
  fc
    .record({
      field: fc.constantFrom("name", "description"),
      value: lifecycleText,
    })
    .map(
      ({ field, value }) =>
        new LifecycleCommand({ type: "server-edit", field, value }),
    ),
  fc.constant(new LifecycleCommand({ type: "other-playbook" })),
  fc.constant(new LifecycleCommand({ type: "delete" })),
  fc.constant(new LifecycleCommand({ type: "unload" })),
  fc
    .constantFrom(1, 2, 3, 4)
    .map(
      (intervals) =>
        new LifecycleCommand({ type: "persistent-failure", intervals }),
    ),
];

test(
  "real editor lifecycle preserves user intent and rejects stale writes across generated commands",
  async () => {
    await assertProperty(
      "real editor lifecycle preserves user intent and rejects stale writes across generated commands",
      fc.asyncProperty(
        lifecycleText,
        lifecycleText,
        fc.commands(lifecycleCommandArbitraries, { maxCommands: 20 }),
        async (localName, remoteName, commands) => {
          const backend: PropertyBackend = {
            clock: 0,
            rows: new Map([[PLAYBOOK_ID, detail("approved")]]),
            pending: [],
            putCount: 0,
            missingMethods: [],
            writes: [],
            reads: [],
          };
          propertyBackend = backend;
          const mounted = await mountEditor("approved");
          const real: LifecycleReal = { ...mounted, backend };
          const initial = {
            name: detail("approved").name,
            description: detail("approved").description,
          };
          const model: LifecycleModel = {
            mode: "open",
            status: "approved",
            draft: { ...initial },
            baseline: { ...initial },
            baselineVersion: 0,
            server: { ...initial },
            serverVersion: 0,
            observedServer: { ...initial },
            observedVersion: 0,
            clock: 0,
            saveFailed: false,
            confirmation: "none",
            pending: [],
            unacknowledged: [],
            steps: 0,
          };
          jest.useFakeTimers();
          try {
            // Every trial reaches the saved-hidden-baseline race with generated content.
            await new LifecycleCommand({
              type: "edit",
              field: "name",
              value: `local ${localName}`,
            }).run(model, real);
            await new LifecycleCommand({ type: "other-playbook" }).run(
              model,
              real,
            );
            await new LifecycleCommand({ type: "save" }).run(model, real);
            await new LifecycleCommand({ type: "hide" }).run(model, real);
            await new LifecycleCommand({ type: "commit" }).run(model, real);
            await new LifecycleCommand({ type: "refetch" }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "saved",
            }).run(model, real);
            expect(hasUnsavedWork()).toBe(false);
            await new LifecycleCommand({ type: "open" }).run(model, real);
            await new LifecycleCommand({
              type: "edit",
              field: "name",
              value: `parked ${localName}`,
            }).run(model, real);
            await new LifecycleCommand({ type: "hide" }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "saved",
            }).run(model, real);
            await serverEditLifecycle(model, real, {
              name: `remote ${remoteName}`,
              description: `remote description ${remoteName}`,
            });
            await assertLifecycleOracle(model, real);
            await new LifecycleCommand({ type: "open" }).run(model, real);
            expect(backend.writes).toHaveLength(2);
            // The read observes an accepted older edit before its response arrives.
            const beforeCommittedRead = model.baseline.name;
            await new LifecycleCommand({
              type: "edit",
              field: "name",
              value: `committed ${localName}`,
            }).run(model, real);
            await new LifecycleCommand({ type: "save" }).run(model, real);
            await new LifecycleCommand({ type: "revert" }).run(model, real);
            await new LifecycleCommand({ type: "commit" }).run(model, real);
            await new LifecycleCommand({ type: "refetch" }).run(model, real);
            expect(
              real.view.getByDisplayValue(beforeCommittedRead),
            ).toBeDefined();
            expect(hasUnsavedWork()).toBe(true);
            await new LifecycleCommand({
              type: "complete",
              result: "saved",
            }).run(model, real);
            expect(
              real.view.getByDisplayValue(beforeCommittedRead),
            ).toBeDefined();
            await new LifecycleCommand({ type: "save" }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "saved",
            }).run(model, real);
            // A confirmed read preserves the revert even when the committed response fails.
            const beforeFailedCommittedRead = model.baseline.name;
            await new LifecycleCommand({
              type: "edit",
              field: "name",
              value: `uncertain ${localName}`,
            }).run(model, real);
            await new LifecycleCommand({ type: "save" }).run(model, real);
            await new LifecycleCommand({ type: "revert" }).run(model, real);
            await new LifecycleCommand({ type: "commit" }).run(model, real);
            await new LifecycleCommand({ type: "refetch" }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "failed",
            }).run(model, real);
            expect(
              real.view.getByDisplayValue(beforeFailedCommittedRead),
            ).toBeDefined();
            expect(hasUnsavedWork()).toBe(true);
            await new LifecycleCommand({ type: "save" }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "saved",
            }).run(model, real);
            expect(backend.rows.get(PLAYBOOK_ID)?.name).toBe(
              beforeFailedCommittedRead,
            );
            // An unchanged fresh read clears stale submission masks before a later clean follow.
            await new LifecycleCommand({
              type: "edit",
              field: "name",
              value: `verified unchanged ${localName}`,
            }).run(model, real);
            await new LifecycleCommand({ type: "save" }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "failed",
            }).run(model, real);
            await new LifecycleCommand({ type: "revert" }).run(model, real);
            const writesBeforeExternalFollow = backend.writes.length;
            const externalFollowName = `remote after verified ${remoteName}`;
            await new LifecycleCommand({
              type: "server-edit",
              field: "name",
              value: externalFollowName,
            }).run(model, real);
            expect(
              real.view.getByDisplayValue(externalFollowName),
            ).toBeDefined();
            await act(async () => {
              jest.advanceTimersByTime(2100);
            });
            await assertLifecycleOracle(model, real);
            expect(backend.pending).toHaveLength(0);
            expect(backend.writes).toHaveLength(writesBeforeExternalFollow);
            // A rejected transport request must leave the real queue recoverable by Retry.
            const rejectedDraftName = `rejected ${localName}`;
            await new LifecycleCommand({
              type: "edit",
              field: "name",
              value: rejectedDraftName,
            }).run(model, real);
            await new LifecycleCommand({ type: "save" }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "rejected",
            }).run(model, real);
            await new LifecycleCommand({
              type: "persistent-failure",
              intervals: 2,
            }).run(model, real);
            expect(
              real.view.getByDisplayValue(rejectedDraftName),
            ).toBeDefined();
            await new LifecycleCommand({ type: "save" }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "saved",
            }).run(model, real);
            expect(backend.rows.get(PLAYBOOK_ID)?.name).toBe(rejectedDraftName);
            // A rejected response can follow a committed write that a fresh read already sees.
            const beforeRejectedCommittedRead = model.baseline.name;
            await new LifecycleCommand({
              type: "edit",
              field: "name",
              value: `rejected committed ${localName}`,
            }).run(model, real);
            await new LifecycleCommand({ type: "save" }).run(model, real);
            await new LifecycleCommand({ type: "revert" }).run(model, real);
            await new LifecycleCommand({ type: "commit" }).run(model, real);
            await new LifecycleCommand({ type: "refetch" }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "rejected",
            }).run(model, real);
            expect(
              real.view.getByDisplayValue(beforeRejectedCommittedRead),
            ).toBeDefined();
            expect(hasUnsavedWork()).toBe(true);
            await new LifecycleCommand({ type: "save" }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "saved",
            }).run(model, real);
            expect(backend.rows.get(PLAYBOOK_ID)?.name).toBe(
              beforeRejectedCommittedRead,
            );
            // Hidden history survives both a committed-but-failed reply and the queued conflict.
            const hiddenFinalName = model.baseline.name;
            await new LifecycleCommand({
              type: "edit",
              field: "name",
              value: `hidden uncertain ${localName}`,
            }).run(model, real);
            await new LifecycleCommand({ type: "save" }).run(model, real);
            await new LifecycleCommand({ type: "revert" }).run(model, real);
            await new LifecycleCommand({ type: "hide" }).run(model, real);
            await new LifecycleCommand({ type: "commit" }).run(model, real);
            await new LifecycleCommand({ type: "refetch" }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "failed",
            }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "failed",
            }).run(model, real);
            expect(
              readParkedPlaybookPane(real.tabId, PLAYBOOK_ID)?.draft.name,
            ).toBe(hiddenFinalName);
            expect(hasUnsavedWork()).toBe(true);
            await new LifecycleCommand({ type: "open" }).run(model, real);
            expect(real.view.getByDisplayValue(hiddenFinalName)).toBeDefined();
            await new LifecycleCommand({ type: "save" }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "saved",
            }).run(model, real);
            expect(backend.rows.get(PLAYBOOK_ID)?.name).toBe(hiddenFinalName);
            // Failure keeps the real pane recoverable even after a confirmed retry fails.
            await new LifecycleCommand({
              type: "edit",
              field: "name",
              value: `recoverable ${localName}`,
            }).run(model, real);
            await new LifecycleCommand({ type: "save" }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "failed",
            }).run(model, real);
            await new LifecycleCommand({
              type: "persistent-failure",
              intervals: 4,
            }).run(model, real);
            await new LifecycleCommand({ type: "close" }).run(model, real);
            await new LifecycleCommand({
              type: "answer",
              answer: "confirm",
            }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "failed",
            }).run(model, real);
            await new LifecycleCommand({
              type: "answer",
              answer: "cancel",
            }).run(model, real);
            await new LifecycleCommand({ type: "save" }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "saved",
            }).run(model, real);
            // Reverting while the old edit is in flight must queue the final snapshot on hide.
            await new LifecycleCommand({
              type: "edit",
              field: "name",
              value: `in flight ${localName}`,
            }).run(model, real);
            await new LifecycleCommand({ type: "save" }).run(model, real);
            await new LifecycleCommand({ type: "revert" }).run(model, real);
            await new LifecycleCommand({ type: "hide" }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "saved",
            }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "saved",
            }).run(model, real);
            await new LifecycleCommand({ type: "open" }).run(model, real);
            // A failed final flush must keep a revert dirty against the intermediate accepted write.
            const revertedName = model.baseline.name;
            await new LifecycleCommand({
              type: "edit",
              field: "name",
              value: `partially saved ${localName}`,
            }).run(model, real);
            await new LifecycleCommand({ type: "save" }).run(model, real);
            await new LifecycleCommand({ type: "revert" }).run(model, real);
            await new LifecycleCommand({ type: "hide" }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "saved",
            }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "failed",
            }).run(model, real);
            await new LifecycleCommand({ type: "open" }).run(model, real);
            expect(real.view.getByDisplayValue(revertedName)).toBeDefined();
            expect(hasUnsavedWork()).toBe(true);
            await new LifecycleCommand({ type: "save" }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "saved",
            }).run(model, real);
            // Reopening during the old queue must retain the final intent until its owner settles.
            const earlyReopenName = model.baseline.name;
            await new LifecycleCommand({
              type: "edit",
              field: "name",
              value: `early reopen ${localName}`,
            }).run(model, real);
            await new LifecycleCommand({ type: "save" }).run(model, real);
            await new LifecycleCommand({ type: "revert" }).run(model, real);
            await new LifecycleCommand({ type: "hide" }).run(model, real);
            await new LifecycleCommand({ type: "open" }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "saved",
            }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "failed",
            }).run(model, real);
            expect(real.view.getByDisplayValue(earlyReopenName)).toBeDefined();
            await new LifecycleCommand({ type: "save" }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "saved",
            }).run(model, real);
            // Failed writes cannot leave an unload guard when a reverted draft equals the server.
            await new LifecycleCommand({
              type: "edit",
              field: "name",
              value: `not persisted ${localName}`,
            }).run(model, real);
            await new LifecycleCommand({ type: "save" }).run(model, real);
            await new LifecycleCommand({ type: "revert" }).run(model, real);
            await new LifecycleCommand({ type: "hide" }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "failed",
            }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "failed",
            }).run(model, real);
            await new LifecycleCommand({ type: "open" }).run(model, real);
            // A newer server token rejects an already-issued request; retry preserves both fields.
            await new LifecycleCommand({
              type: "edit",
              field: "name",
              value: `conflict ${localName}`,
            }).run(model, real);
            await new LifecycleCommand({ type: "save" }).run(model, real);
            await new LifecycleCommand({
              type: "server-edit",
              field: "description",
              value: `new description ${remoteName}`,
            }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "saved",
            }).run(model, real);
            await new LifecycleCommand({ type: "save" }).run(model, real);
            await new LifecycleCommand({
              type: "complete",
              result: "saved",
            }).run(model, real);
            await fc.asyncModelRun(() => ({ model, real }), commands);
            // Surviving trials finish with a dirty deletion; generated deletes are dirty too.
            while (model.pending.length > 0) {
              await new LifecycleCommand({
                type: "complete",
                result: "saved",
              }).run(model, real);
            }
            if (
              model.confirmation === "discard" ||
              model.confirmation === "retry"
            ) {
              await new LifecycleCommand({
                type: "answer",
                answer: "cancel",
              }).run(model, real);
            }
            if (model.mode !== "deleted") {
              if (model.mode !== "open") {
                await new LifecycleCommand({ type: "open" }).run(model, real);
              }
              await new LifecycleCommand({
                type: "edit",
                field: "name",
                value: `delete ${localName}`,
              }).run(model, real);
              await new LifecycleCommand({ type: "delete" }).run(model, real);
            }
            for (const [index, write] of backend.writes.entries()) {
              expect(write.updatedAt > write.expectedUpdatedAt).toBe(true);
              const previous = backend.writes.at(index - 1);
              if (index > 0 && previous !== undefined) {
                expect(write.updatedAt > previous.updatedAt).toBe(true);
              }
            }
          } finally {
            cancelPlaybookPaneLeave();
            // Settle transport before removing the real owner, including a queued flush.
            while (backend.pending.length > 0) {
              const pending = backend.pending.splice(0);
              await act(async () => {
                for (const request of pending) {
                  request.response.resolve(
                    Response.json(
                      { message: "Trial disposed" },
                      { status: 503 },
                    ),
                  );
                }
              });
              await settleLifecycle();
            }
            await act(async () => {
              mounted.view.unmount();
            });
            while (backend.pending.length > 0) {
              const pending = backend.pending.splice(0);
              await act(async () => {
                for (const request of pending) {
                  request.response.resolve(
                    Response.json(
                      { message: "Trial disposed" },
                      { status: 503 },
                    ),
                  );
                }
              });
              await settleLifecycle();
            }
            for (const dispose of cleanups.splice(0)) {
              dispose();
            }
            propertyBackend = null;
            jest.useRealTimers();
          }
        },
      ),
      { numRuns: 12 },
    );
  },
  propertyTestTimeout(30_000),
);
