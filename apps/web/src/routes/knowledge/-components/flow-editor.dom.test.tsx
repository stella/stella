import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic, Result } from "better-result";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import * as v from "valibot";

import { API_VERSION_CONFLICT_ERROR_CODE } from "@stll/api-contract";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";
import { deferred } from "@stll/test-kit";

import type { FlowDefinitionDetail, FlowListItem } from "./flow-types";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
Object.assign(import.meta.env, { VITE_PUBLIC_KNOWLEDGE_ENABLED: "true" });
Object.assign(globalThis, {
  __APP_VERSION__: "test",
  __APP_COMMIT_SHA__: "0000000000000000000000000000000000000000",
});
const { StrictMode } = await import("react");
const { drainReactScheduler } =
  await import("@stll/property-testing/dom-environment");
const { act, cleanup, fireEvent, render, waitFor, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { stellaToast, ToastProvider } = await import("@stll/ui/toast");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const messages = (await import("@/i18n/langs/en.json")).default;
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { MEMBER_SESSION } =
  await import("@/lib/account/auth-session.test-fixtures");
const { installSessionCacheGuard } = await import("@/lib/session-cache-guard");
const { roleOptions, sessionOptions } = await import("@/lib/auth-queries");
const { flowDetailOptions } = await import("@/lib/knowledge/queries");
const { toSafeId } = await import("@/lib/safe-id");
const { FlowEditor } = await import("./flow-editor");
const { Route: WorkflowsRoute } = await import("../workflows");
const originalFetch = globalThis.fetch;
const disposals: (() => void)[] = [];
const FLOW_ID = "00000000-0000-7000-8000-000000000061";
const OTHER_FLOW_ID = "00000000-0000-7000-8000-000000000062";
const initial = {
  id: toSafeId<"flowDefinition">(FLOW_ID),
  name: "Review correspondence",
  description: "Review the incoming correspondence.",
  enabled: true,
  steps: [
    {
      kind: "ai",
      name: "Summarize correspondence",
      prompt: "Summarize the document.",
      includeDocuments: true,
    },
  ],
  trigger: { type: "manual" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.001Z",
} satisfies FlowDefinitionDetail;
const latest = {
  ...initial,
  name: "Review current correspondence",
  description: "Current stored instructions.",
  updatedAt: "2026-01-01T00:00:00.002Z",
} satisfies FlowDefinitionDetail;
const listItem = {
  id: initial.id,
  name: initial.name,
  description: initial.description,
  enabled: true,
  triggerType: "manual",
  stepCount: 1,
  createdAt: initial.createdAt,
  updatedAt: initial.updatedAt,
} satisfies FlowListItem;
const refusal = () =>
  Response.json(
    {
      code: API_VERSION_CONFLICT_ERROR_CODE,
      message: "Workflow changed; reload the current version.",
    },
    { status: 409 },
  );

afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) {
    dispose();
  }
  globalThis.fetch = originalFetch;
});
afterAll(unregisterDomEnvironment);

const mountWorkflow = async (
  mode: "editor" | "list" | "create" = "editor",
  { cached }: { cached?: FlowDefinitionDetail } = {},
) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  let session = MEMBER_SESSION;
  let read = initial;
  let failRead = false;
  let heldRead: ReturnType<typeof deferred<Response>> | undefined;
  let heldWrite: ReturnType<typeof deferred<Response>> | undefined;
  const holds: ReturnType<typeof deferred<Response>>[] = [];
  disposals.push(() => {
    for (const held of holds) {
      held.resolve(Response.json(initial));
    }
  });
  let conflict = true;
  const writes: Record<string, unknown>[] = [];
  const creates: Record<string, unknown>[] = [];
  const putStatuses: number[] = [];
  const requests: Request[] = [];
  const readCaches: (RequestCache | undefined)[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/get-session")) {
        return Response.json(session);
      }
      if (path.endsWith("/get-active-member-role")) {
        return Response.json({ role: "admin" });
      }
      if (path === "/v1/me/professional-use") {
        return Response.json({
          status: "accepted",
          statementVersion: "2026-10",
          termsVersion: "2026-10",
          acceptedAt: "2026-01-01T00:00:00.000Z",
        });
      }
      if (path === "/v1/flows" && request.method === "POST") {
        creates.push(
          v.parse(v.record(v.string(), v.unknown()), await request.json()),
        );
        return Response.json({ id: initial.id });
      }
      if (path === "/v1/flows") {
        return Response.json({
          items: [listItem],
          nextCursor: null,
          limit: 50,
        });
      }
      if (path.startsWith("/v1/flows/") && request.method === "GET") {
        readCaches.push(init?.cache);
        if (heldRead) {
          const held = heldRead;
          heldRead = undefined;
          return await held.promise;
        }
        if (failRead) {
          return Response.json(
            { message: "Workflow read failed" },
            { status: 500 },
          );
        }
        return Response.json(
          path.endsWith(OTHER_FLOW_ID)
            ? { ...read, id: OTHER_FLOW_ID, name: "Other workflow" }
            : read,
        );
      }
      if (path.startsWith("/v1/flows/") && request.method === "PUT") {
        writes.push(
          v.parse(v.record(v.string(), v.unknown()), await request.json()),
        );
        const response = heldWrite
          ? await heldWrite.promise
          : Response.json({ id: initial.id, updatedAt: latest.updatedAt });
        const outcome = !heldWrite && conflict ? refusal() : response;
        putStatuses.push(outcome.status);
        return outcome;
      }
      if (path.startsWith("/v1/flows/") && request.method === "DELETE") {
        if (heldWrite) {
          return await heldWrite.promise;
        }
        return Response.json({ id: initial.id });
      }
      if (path.includes("/workspaces")) {
        return Response.json({
          workspaces: [],
          features: { timeBilling: false },
        });
      }
      return Response.json(
        { message: `Unexpected fixture request: ${path}` },
        { status: 404 },
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  client.setQueryData(sessionOptions.queryKey, session);
  const stop = installSessionCacheGuard(client, {
    isAuthFlowPage: () => false,
    reloadDocument: () => undefined,
    reloadDocumentAt: () => undefined,
  });
  disposals.push(() => {
    stop();
    client.clear();
  });
  await client.query(roleOptions);
  if (cached !== undefined) {
    client.setQueryData(
      flowDetailOptions(session.session.activeOrganizationId, FLOW_ID).queryKey,
      cached,
    );
    read = latest;
    conflict = false;
  }
  const saved = spyOn(stellaToast, "add");
  disposals.push(() => saved.mockRestore());
  let completed = 0;
  const Component =
    WorkflowsRoute.options.component ??
    panic("Workflow route requires its component");
  const root = createRootRoute();
  const route = createRoute({
    getParentRoute: () => root,
    path: "/knowledge/workflows",
    component: Component,
  });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/knowledge/workflows"] }),
  });
  const view = (flowId: string = FLOW_ID) => (
    <StrictMode>
      <QueryClientProvider client={client}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <FormattingProvider locale="en" timeZone="UTC">
            <TooltipProvider>
              <ToastProvider>
                <AuthenticatedUserProvider
                  user={{
                    id: session.user.id,
                    activeOrganizationId: session.session.activeOrganizationId,
                    name: session.user.name,
                    email: session.user.email,
                    image: null,
                    preferredName: null,
                    timezoneId: "UTC",
                    wordEditShortcut: null,
                  }}
                >
                  {mode !== "list" ? (
                    <FlowEditor
                      flowId={mode === "create" ? null : flowId}
                      example={
                        mode === "create" ? "document-summary" : undefined
                      }
                      organizationId={session.session.activeOrganizationId}
                      onBack={() => {
                        completed += 1;
                      }}
                      onSaved={() => {
                        completed += 1;
                      }}
                    />
                  ) : (
                    <RouterProvider router={router} />
                  )}
                </AuthenticatedUserProvider>
              </ToastProvider>
            </TooltipProvider>
          </FormattingProvider>
        </IntlProvider>
      </QueryClientProvider>
    </StrictMode>
  );
  const rendered = render(view());
  const openedName = cached === undefined ? initial.name : latest.name;
  if (mode !== "list") {
    await rendered.findByDisplayValue(
      mode === "create"
        ? messages.flows.examples.documentSummary.name
        : openedName,
    );
  } else {
    await rendered.findByText(initial.name);
  }
  const save = () =>
    fireEvent.click(
      rendered.getByRole("button", { name: messages.common.save }),
    );
  const changeName = (name: string) =>
    fireEvent.change(
      rendered.getByLabelText(messages.common.name, { selector: "#flow-name" }),
      {
        target: { value: name },
      },
    );
  const confirmReload = async () => {
    fireEvent.click(
      rendered.getByRole("button", { name: messages.common.reload }),
    );
    const dialog = await rendered.findByRole("alertdialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: messages.common.reload }),
    );
  };
  return {
    client,
    rendered,
    writes,
    creates,
    putStatuses,
    requests,
    readCaches,
    saved,
    save,
    changeName,
    confirmReload,
    completed: () => completed,
    latest: () => {
      read = latest;
      conflict = false;
    },
    failRead: () => {
      failRead = true;
    },
    holdRead: () => {
      heldRead = deferred<Response>();
      holds.push(heldRead);
      return heldRead;
    },
    holdWrite: () => {
      heldWrite = deferred<Response>();
      holds.push(heldWrite);
      return heldWrite;
    },
    rerenderFlow: (flowId: string) => rendered.rerender(view(flowId)),
    owner: (userId: string, organizationId: string) => {
      session = {
        ...MEMBER_SESSION,
        session: {
          ...MEMBER_SESSION.session,
          activeOrganizationId: organizationId,
          userId,
        },
        user: { ...MEMBER_SESSION.user, id: userId },
      };
      client.setQueryData(sessionOptions.queryKey, session);
      rendered.rerender(view());
    },
  };
};

test("an initialized workflow keeps its draft and original version across background reads and errors", async () => {
  const f = await mountWorkflow();
  f.changeName("My correspondence draft");
  f.latest();
  await act(async () => {
    await f.client.query({
      ...flowDetailOptions(
        MEMBER_SESSION.session.activeOrganizationId,
        FLOW_ID,
      ),
      staleTime: 0,
    });
  });
  expect(f.rendered.getByDisplayValue("My correspondence draft")).toBeDefined();
  f.failRead();
  await act(async () => {
    const failed = await Result.tryPromise(
      async () =>
        await f.client.query({
          ...flowDetailOptions(
            MEMBER_SESSION.session.activeOrganizationId,
            FLOW_ID,
          ),
          staleTime: 0,
        }),
    );
    expect(failed.isErr()).toBe(true);
  });
  f.save();
  await waitFor(() => expect(f.writes).toHaveLength(1));
  expect(f.writes.at(0)).toMatchObject({
    name: "My correspondence draft",
    expectedUpdatedAt: initial.updatedAt,
  });
});

test("opening a workflow drafts from a fresh read instead of a cached detail", async () => {
  const f = await mountWorkflow("editor", { cached: initial });
  expect(f.rendered.queryByDisplayValue(initial.name)).toBeNull();
  f.changeName("Edited after opening");
  f.save();
  await waitFor(() => expect(f.writes).toHaveLength(1));
  expect(f.writes.at(0)).toMatchObject({
    name: "Edited after opening",
    expectedUpdatedAt: latest.updatedAt,
  });
});

test("a workflow conflict preserves edits and requires confirmed fresh atomic reload before saving", async () => {
  const f = await mountWorkflow();
  f.changeName("My correspondence draft");
  f.save();
  await within(f.rendered.container).findByText(
    messages.errors.apiCodes.versionConflict,
  );
  expect(f.writes).toHaveLength(1);
  expect(
    f.rendered
      .getByRole("button", {
        name: messages.common.save,
        description: messages.flows.reloadToSave,
      })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  fireEvent.click(
    f.rendered.getByRole("button", { name: messages.common.reload }),
  );
  const dialog = await f.rendered.findByRole("alertdialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: messages.common.cancel }),
  );
  await waitFor(() =>
    expect(f.rendered.queryByRole("alertdialog") === null).toBe(true),
  );
  expect(f.writes).toHaveLength(1);
  f.latest();
  await f.confirmReload();
  await f.rendered.findByDisplayValue(latest.name);
  expect(f.rendered.getByDisplayValue(latest.description)).toBeDefined();
  f.save();
  await waitFor(() => expect(f.writes).toHaveLength(2));
  expect(f.writes.at(1)).toMatchObject({
    name: latest.name,
    description: latest.description,
    expectedUpdatedAt: latest.updatedAt,
  });
});

test("editing during held reload keeps the draft, original token and persistent conflict together", async () => {
  const f = await mountWorkflow();
  f.changeName("First draft");
  f.save();
  await within(f.rendered.container).findByText(
    messages.errors.apiCodes.versionConflict,
  );
  const held = f.holdRead();
  await f.confirmReload();
  f.changeName("Draft typed while loading");
  await act(async () => held.resolve(Response.json(latest)));
  await waitFor(() =>
    expect(
      f.rendered.getByDisplayValue("Draft typed while loading"),
    ).toBeDefined(),
  );
  expect(
    within(f.rendered.container).getByText(
      messages.errors.apiCodes.versionConflict,
    ),
  ).toBeDefined();
  expect(
    f.rendered
      .getByRole("button", {
        name: messages.common.save,
        description: messages.flows.reloadToSave,
      })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  expect(f.writes).toHaveLength(1);
});

test("a held workflow save disables draft editing under StrictMode", async () => {
  const f = await mountWorkflow();
  const held = f.holdWrite();
  f.changeName("Submitted draft");
  f.save();
  f.save();
  await waitFor(() => expect(f.writes).toHaveLength(1));
  const fieldset = f.rendered
    .getByLabelText(messages.common.name, { selector: "#flow-name" })
    .closest("fieldset");
  expect(fieldset).toHaveProperty("disabled", true);
  const controls = f.rendered.container.querySelectorAll(
    "input, textarea, select, [role=switch], [role=combobox]",
  );
  expect(controls.length).toBeGreaterThan(2);
  for (const control of controls) {
    expect(control.closest("fieldset")).toBe(fieldset);
  }
  expect(f.writes).toHaveLength(1);
  await act(async () =>
    held.resolve(
      Response.json({ id: initial.id, updatedAt: latest.updatedAt }),
    ),
  );
  await waitFor(() => expect(f.completed()).toBe(1));
});

for (const { retirement } of [
  { retirement: "organization" },
  { retirement: "user" },
  { retirement: "flow" },
  { retirement: "ownerABA" },
  { retirement: "unmount" },
] as const) {
  test(`late workflow reload cannot adopt after ${retirement} changes`, async () => {
    const f = await mountWorkflow();
    f.changeName("Retained draft");
    f.save();
    await within(f.rendered.container).findByText(
      messages.errors.apiCodes.versionConflict,
    );
    const held = f.holdRead();
    await f.confirmReload();
    await act(async () => {
      switch (retirement) {
        case "organization":
          f.owner(MEMBER_SESSION.user.id, "org_other");
          break;
        case "user":
          f.owner("user_other", MEMBER_SESSION.session.activeOrganizationId);
          break;
        case "flow":
          f.rerenderFlow(OTHER_FLOW_ID);
          break;
        case "ownerABA":
          f.owner(MEMBER_SESSION.user.id, "org_other");
          f.owner(
            MEMBER_SESSION.user.id,
            MEMBER_SESSION.session.activeOrganizationId,
          );
          break;
        case "unmount":
          f.rendered.unmount();
          break;
        default:
          retirement satisfies never;
          panic("Unhandled reload retirement");
      }
      held.resolve(Response.json(latest));
      await drainReactScheduler();
    });
    expect(f.rendered.queryByDisplayValue(latest.name)).toBeNull();
    expect(f.writes).toHaveLength(1);
    expect(f.completed()).toBe(0);
  });
}

test("the workflow toggle uses a fresh detail and its matching version", async () => {
  const f = await mountWorkflow("list");
  f.client.setQueryData(
    flowDetailOptions(MEMBER_SESSION.session.activeOrganizationId, FLOW_ID)
      .queryKey,
    initial,
  );
  f.latest();
  fireEvent.click(
    f.rendered.getByRole("switch", { name: messages.flows.disableFlow }),
  );
  await waitFor(() => expect(f.writes).toHaveLength(1));
  expect(f.writes.at(0)).toMatchObject({
    name: latest.name,
    description: latest.description,
    enabled: false,
    expectedUpdatedAt: latest.updatedAt,
  });
  const get = f.requests.find(
    (request) =>
      new URL(request.url).pathname === `/v1/flows/${FLOW_ID}` &&
      request.method === "GET",
  );
  expect(get).toBeDefined();
  expect(f.readCaches).toEqual(["no-store"]);
});

for (const { retirement } of [
  { retirement: "organization" },
  { retirement: "user" },
  { retirement: "ownerABA" },
  { retirement: "unmount" },
] as const) {
  test(`a toggle never sends its replacement after held GET and ${retirement} changes`, async () => {
    const f = await mountWorkflow("list");
    const held = f.holdRead();
    fireEvent.click(
      f.rendered.getByRole("switch", { name: messages.flows.disableFlow }),
    );
    await waitFor(() =>
      expect(
        f.requests.some(
          (request) => new URL(request.url).pathname === `/v1/flows/${FLOW_ID}`,
        ),
      ).toBe(true),
    );
    await act(async () => {
      switch (retirement) {
        case "organization":
          f.owner(MEMBER_SESSION.user.id, "org_other");
          break;
        case "user":
          f.owner("user_other", MEMBER_SESSION.session.activeOrganizationId);
          break;
        case "ownerABA":
          f.owner(MEMBER_SESSION.user.id, "org_other");
          f.owner(
            MEMBER_SESSION.user.id,
            MEMBER_SESSION.session.activeOrganizationId,
          );
          break;
        case "unmount":
          f.rendered.unmount();
          break;
        default:
          retirement satisfies never;
          panic("Unhandled toggle retirement");
      }
      held.resolve(Response.json(latest));
      await drainReactScheduler();
    });
    expect(f.writes).toEqual([]);
    if (retirement === "ownerABA") {
      await waitFor(() =>
        expect(
          f.rendered.getByRole("switch", { name: messages.flows.disableFlow })
            .dataset["disabled"] === undefined,
        ).toBe(true),
      );
    }
  });
}

test("a conflicting toggle is reported once without another PUT", async () => {
  const f = await mountWorkflow("list");
  fireEvent.click(
    f.rendered.getByRole("switch", { name: messages.flows.disableFlow }),
  );
  await waitFor(() => expect(f.writes).toHaveLength(1));
  await waitFor(() => expect(f.saved).toHaveBeenCalledTimes(1));
  expect(f.putStatuses).toEqual([409]);
  expect(f.writes.at(0)).toMatchObject({
    expectedUpdatedAt: initial.updatedAt,
  });
  expect(f.writes).toHaveLength(1);
});

test("a failed explicit workflow reload retains the edited draft and conflict", async () => {
  const f = await mountWorkflow();
  f.changeName("Preserved correspondence draft");
  f.save();
  await within(f.rendered.container).findByText(
    messages.errors.apiCodes.versionConflict,
  );
  f.failRead();
  await f.confirmReload();
  await waitFor(() => expect(f.saved).toHaveBeenCalledTimes(2));
  expect(
    f.rendered.getByDisplayValue("Preserved correspondence draft"),
  ).toBeDefined();
  expect(
    within(f.rendered.container).getByText(
      messages.errors.apiCodes.versionConflict,
    ),
  ).toBeDefined();
  expect(
    f.rendered
      .getByRole("button", {
        name: messages.common.save,
        description: messages.flows.reloadToSave,
      })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  expect(f.writes).toHaveLength(1);
});

for (const { operation } of [
  { operation: "save" },
  { operation: "delete" },
] as const) {
  test(`a held workflow ${operation} cannot finish navigation after its owner retires`, async () => {
    const f = await mountWorkflow();
    const held = f.holdWrite();
    switch (operation) {
      case "save":
        f.save();
        break;
      case "delete": {
        fireEvent.click(
          f.rendered.getByRole("button", { name: messages.flows.deleteFlow }),
        );
        const dialog = await f.rendered.findByRole("alertdialog");
        fireEvent.click(
          within(dialog).getByRole("button", { name: messages.common.delete }),
        );
        break;
      }
      default:
        operation satisfies never;
        panic("Unhandled workflow write");
    }
    await waitFor(() =>
      expect(
        f.requests.some(
          (request) =>
            request.method === (operation === "save" ? "PUT" : "DELETE"),
        ),
      ).toBe(true),
    );
    await act(async () => {
      f.owner(MEMBER_SESSION.user.id, "org_other");
      held.resolve(
        Response.json({ id: initial.id, updatedAt: latest.updatedAt }),
      );
      await drainReactScheduler();
    });
    expect(f.completed()).toBe(0);
    expect(f.saved).not.toHaveBeenCalled();
  });
}

test("a current owner's workflow deletion still completes navigation", async () => {
  const f = await mountWorkflow();
  fireEvent.click(
    f.rendered.getByRole("button", { name: messages.flows.deleteFlow }),
  );
  const dialog = await f.rendered.findByRole("alertdialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: messages.common.delete }),
  );
  await waitFor(() => expect(f.completed()).toBe(1));
});

for (const { operation } of [
  { operation: "save" },
  { operation: "delete" },
  { operation: "toggle" },
] as const) {
  test(`a successful ${operation} still invalidates its captured flow cache after unmount`, async () => {
    const f = await mountWorkflow(operation === "toggle" ? "list" : "editor");
    const options = flowDetailOptions(
      MEMBER_SESSION.session.activeOrganizationId,
      FLOW_ID,
    );
    f.client.setQueryData(options.queryKey, initial);
    const unrelated = flowDetailOptions("org_unrelated", FLOW_ID);
    f.client.setQueryData(unrelated.queryKey, latest);
    expect(f.client.getQueryState(options.queryKey)?.isInvalidated).toBe(false);
    expect(f.client.getQueryState(unrelated.queryKey)?.isInvalidated).toBe(
      false,
    );
    const held = f.holdWrite();
    switch (operation) {
      case "save":
        f.save();
        break;
      case "delete": {
        fireEvent.click(
          f.rendered.getByRole("button", { name: messages.flows.deleteFlow }),
        );
        const dialog = await f.rendered.findByRole("alertdialog");
        fireEvent.click(
          within(dialog).getByRole("button", { name: messages.common.delete }),
        );
        break;
      }
      case "toggle":
        fireEvent.click(
          f.rendered.getByRole("switch", { name: messages.flows.disableFlow }),
        );
        break;
      default:
        operation satisfies never;
        panic("Unhandled unmounted workflow completion");
    }
    await waitFor(() =>
      expect(
        f.requests.some(
          (request) =>
            request.method === (operation === "delete" ? "DELETE" : "PUT"),
        ),
      ).toBe(true),
    );
    f.rendered.unmount();
    await act(async () =>
      held.resolve(
        Response.json({ id: initial.id, updatedAt: latest.updatedAt }),
      ),
    );
    await waitFor(() =>
      expect(f.client.getQueryState(options.queryKey)?.isInvalidated).toBe(
        true,
      ),
    );
    const write = f.requests.find(
      (request) =>
        request.method === (operation === "delete" ? "DELETE" : "PUT"),
    );
    expect(write?.signal.aborted).toBe(false);
    expect(f.client.getQueryState(unrelated.queryKey)?.isInvalidated).toBe(
      false,
    );
    expect(f.completed()).toBe(0);
    expect(f.saved).not.toHaveBeenCalled();
  });
}

test("creating a workflow keeps the creation body free of a replacement version", async () => {
  const f = await mountWorkflow("create");
  f.save();
  await waitFor(() => expect(f.completed()).toBe(1));
  expect(f.creates).toHaveLength(1);
  expect(f.creates.at(0)).toMatchObject({
    name: messages.flows.examples.documentSummary.name,
    trigger: { type: "manual" },
    enabled: true,
  });
  expect(f.creates.at(0)).not.toHaveProperty("expectedUpdatedAt");
  expect(f.writes).toEqual([]);
});

test("an anonymous workflow page requests public Knowledge without requiring a member provider", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  disposals.push(() => client.clear());
  client.setQueryData(sessionOptions.queryKey, null);
  const requests: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (new URL(request.url).pathname.endsWith("/get-session")) {
        return Response.json(null);
      }
      return Response.json(
        { message: "Unexpected anonymous fixture request" },
        { status: 404 },
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  const { Route: KnowledgeLayout } = await import("../route");
  const { Route: KnowledgeIndex } = await import("../index");
  const root = createRootRoute();
  const knowledge = createRoute({
    getParentRoute: () => root,
    path: "/knowledge",
    component:
      KnowledgeLayout.options.component ??
      panic("Knowledge requires its layout"),
  });
  const workflows = createRoute({
    getParentRoute: () => knowledge,
    path: "workflows",
    component:
      WorkflowsRoute.options.component ??
      panic("Workflow route requires its component"),
  });
  const landing = createRoute({
    getParentRoute: () => knowledge,
    path: "/",
    validateSearch: KnowledgeIndex.options.validateSearch,
    component: () => <p>{messages.common.catalogue}</p>,
  });
  const router = createRouter({
    isServer: false,
    routeTree: root.addChildren([knowledge.addChildren([workflows, landing])]),
    history: createMemoryHistory({ initialEntries: ["/knowledge/workflows"] }),
  });
  await router.load();
  const navigation = spyOn(router, "navigate").mockResolvedValue(undefined);
  let rendered: ReturnType<typeof render> | undefined;
  try {
    rendered = render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <IntlProvider locale="en" messages={messages} timeZone="UTC">
            <RouterProvider router={router} />
          </IntlProvider>
        </QueryClientProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(navigation.mock.calls.length).toBe(1));
    expect(navigation).toHaveBeenCalledWith({
      replace: true,
      to: "/knowledge",
      search: { from: "/knowledge/workflows" },
    });
    expect(
      requests.some((request) =>
        new URL(request.url).pathname.startsWith("/v1/flows"),
      ),
    ).toBe(false);
  } finally {
    rendered?.unmount();
    navigation.mockRestore();
  }
});
