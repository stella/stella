import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import {
  API_VALIDATION_ERROR_CODE,
  IDEMPOTENCY_IN_PROGRESS_CODE,
} from "@stll/api-contract";
import { CAPABILITY_REQUEST_HEADER } from "@stll/api-contract/capability-request";
import {
  ORGANIZATION_EVALUATION_LIMIT,
  ORGANIZATION_EVALUATION_LIMIT_REACHED_CODE,
  ORGANIZATION_NAME_MAX_LENGTH,
} from "@stll/api-contract/organization-create";

import ar from "@/i18n/langs/ar.json";
import en from "@/i18n/langs/en.json";
import type { TranslationKey } from "@/i18n/types";
import type { WebApiRoutes } from "@/lib/api";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/settings" });
Object.assign(globalThis, {
  __APP_VERSION__: "test",
  __APP_COMMIT_SHA__: "0000000000000000000000000000000000000000",
});
const { useState } = await import("react");
const { act, cleanup, fireEvent, render, screen, waitFor, within } =
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
const { IntlProvider, createTranslator } = await import("use-intl");
const { Button } = await import("@stll/ui/button");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { drainReactScheduler } = await import("@/lib/react-scheduler-drain");
const { supportedLanguages } = await import("@/i18n/i18n-store");
const { CreateOrganizationDialog } =
  await import("./create-organization-dialog");
const { SidebarUserMenu } = await import("./sidebar-user-menu");
const { SidebarProvider, SidebarMenu } = await import("@stll/ui/sidebar");
const { roleOptions } = await import("@/lib/auth-queries");
const { organizationListOptions } = await import("@/lib/organization/queries");

type CreatedOrganization =
  WebApiRoutes["organizations"]["post"]["response"][200];
const ORGANIZATION_ID = "019a0000-0000-7000-8000-000000000601";
const USER_ID = "019a0000-0000-7000-8000-000000000602";
const ORIGINAL_ORGANIZATION_ID = "019a0000-0000-7000-8000-000000000603";
const CREATED_ORGANIZATION = {
  organizationId: ORGANIZATION_ID,
  name: "New firm",
  slug: "new-firm",
  role: "owner",
  nextCall: {
    command: "stella auth login",
    instruction: "Select the new organization.",
  },
} as const satisfies CreatedOrganization;
const originalFetch = globalThis.fetch;
const requests: { path: string; body: unknown; capability: string | null }[] =
  [];
const clients: InstanceType<typeof QueryClient>[] = [];
const creationKeys: (string | null)[] = [];
// A receipt represents a committed server creation, even when its response is lost.
const serverReceipts = new Map<string, CreatedOrganization>();
let createOutcome: "created" | "refused" | "response-lost" = "created";
let refusalResponse: { code: string; status: number } | undefined;
let unknownFailureResponse: (() => Response) | undefined;
let switchOutcome: "switched" | "refused" = "switched";
let deferredCreate: Promise<Response> | undefined;
let deferredSwitch: Promise<Response> | undefined;

const createdResponse = () => Response.json(CREATED_ORGANIZATION);
const switchedResponse = () =>
  Response.json({ id: ORGANIZATION_ID, name: "New firm", slug: "new-firm" });
const switchRequests = () =>
  requests.filter(({ path }) => path.endsWith("/organization/set-active"));

globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method === "POST") {
      requests.push({
        path,
        body: await request.json(),
        capability: request.headers.get(CAPABILITY_REQUEST_HEADER),
      });
    }
    if (path === "/v1/organizations" && request.method === "POST") {
      const key = request.headers.get("Idempotency-Key");
      creationKeys.push(key);
      if (key === null) {
        throw new TypeError("Organization creation requires a replay key");
      }
      if (refusalResponse !== undefined) {
        return Response.json(
          {
            code: refusalResponse.code,
            message: "Untranslated server refusal sentinel",
          },
          { status: refusalResponse.status },
        );
      }
      if (createOutcome === "refused") {
        return Response.json(
          {
            code: "organization_creation_refused",
            message: "Creation refused",
          },
          { status: 403 },
        );
      }
      let organization = serverReceipts.get(key);
      if (organization === undefined) {
        organization =
          serverReceipts.size === 0
            ? CREATED_ORGANIZATION
            : {
                ...CREATED_ORGANIZATION,
                organizationId: "019a0000-0000-7000-8000-000000000604",
                slug: "new-firm-2",
              };
        serverReceipts.set(key, organization);
      }
      if (unknownFailureResponse !== undefined) {
        return unknownFailureResponse();
      }
      if (createOutcome === "response-lost") {
        throw new TypeError("Creation committed but its response was lost");
      }
      if (deferredCreate) {
        return await deferredCreate;
      }
      return Response.json(organization);
    }
    if (path.endsWith("/organization/set-active")) {
      if (deferredSwitch) {
        return await deferredSwitch;
      }
      return switchOutcome === "switched"
        ? switchedResponse()
        : Response.json(
            { code: "FORBIDDEN", message: "Switch refused" },
            { status: 403 },
          );
    }
    if (path.endsWith("/organization/get-active-member-role")) {
      return Response.json({ role: "owner" });
    }
    throw new TypeError(
      `Unexpected organization dialog request: ${request.method} ${path}`,
    );
  },
  { preconnect: originalFetch.preconnect },
);

afterEach(async () => {
  await act(async () => cleanup());
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  requests.length = 0;
  creationKeys.length = 0;
  serverReceipts.clear();
  createOutcome = "created";
  refusalResponse = undefined;
  unknownFailureResponse = undefined;
  switchOutcome = "switched";
  deferredCreate = undefined;
  deferredSwitch = undefined;
  document.documentElement.dir = "ltr";
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const DialogHost = () => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        {en.organization.newOrganization}
      </Button>
      {open && (
        <CreateOrganizationDialog
          open
          userId={USER_ID}
          onOpenChange={setOpen}
        />
      )}
    </>
  );
};

type RenderCreationSurfaceOptions = {
  locale?: "en" | "ar";
  surface?: "dialog" | "sidebar";
  queryClient?: InstanceType<typeof QueryClient>;
};

const renderCreationSurface = async ({
  locale = "en",
  surface = "dialog",
  queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  }),
}: RenderCreationSurfaceOptions = {}) => {
  const messages = locale === "ar" ? ar : en;
  document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";
  if (!clients.includes(queryClient)) {
    clients.push(queryClient);
  }
  queryClient.setQueryData(roleOptions.queryKey, "owner");
  queryClient.setQueryData(organizationListOptions(USER_ID).queryKey, [
    {
      id: ORIGINAL_ORGANIZATION_ID,
      name: "Original firm",
      slug: "original-firm",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      logo: null,
    },
  ]);
  const root = createRootRoute();
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/settings",
    component: () =>
      surface === "dialog" ? (
        <DialogHost />
      ) : (
        <SidebarProvider defaultOpen>
          <SidebarMenu>
            <SidebarUserMenu
              user={{
                activeOrganizationId: ORIGINAL_ORGANIZATION_ID,
                email: "member@example.test",
                id: USER_ID,
                image: null,
                name: "Test member",
              }}
            />
          </SidebarMenu>
        </SidebarProvider>
      ),
  });
  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <div>{messages.common.done}</div>,
  });
  const other = createRoute({
    getParentRoute: () => root,
    path: "/other",
    component: () => <div>{messages.common.settings}</div>,
  });
  const router = createRouter({
    routeTree: root.addChildren([settings, home, other]),
    history: createMemoryHistory({ initialEntries: ["/settings"] }),
  });
  await router.load();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale={locale} messages={messages} timeZone="UTC">
        <TooltipProvider delay={0}>
          <RouterProvider router={router} />
        </TooltipProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  const openDialog = async () => {
    if (surface === "sidebar") {
      fireEvent.click(
        await screen.findByRole("button", { name: /Test member/u }),
      );
      const createItem = screen.queryByRole("menuitem", {
        name: messages.organization.newOrganization,
      });
      fireEvent.click(
        createItem ??
          (await screen.findByRole("menuitem", {
            name: new RegExp(messages.organization.switchOrganization, "u"),
          })),
      );
    } else {
      fireEvent.click(
        await screen.findByRole("button", {
          name: en.organization.newOrganization,
        }),
      );
    }
    const dialog = await screen.findByRole("dialog", {
      name: messages.organization.newOrganization,
    });
    await act(async () => await drainReactScheduler());
    return dialog;
  };
  return { router, messages, queryClient, openDialog, unmount: view.unmount };
};

const fillName = (messages: typeof en | typeof ar, name = "New firm") => {
  fireEvent.change(
    screen.getByRole("textbox", { name: messages.common.organizationName }),
    { target: { value: name } },
  );
};

const createOrganization = (messages: typeof en | typeof ar) => {
  act(() => {
    const button = screen.getByRole("button", {
      name: messages.auth.createOrganizationButton,
    });
    button.focus();
    fireEvent.click(button);
  });
};

const switchOrganization = async (button: HTMLElement) => {
  await act(async () => {
    fireEvent.click(button);
    await drainReactScheduler();
  });
};

const expectCreated = async (messages: typeof en | typeof ar) => {
  expect(await screen.findByText(CREATED_ORGANIZATION.slug)).toBeTruthy();
  expect(
    screen
      .getByRole("textbox", { name: messages.common.organizationName })
      .getAttribute("value"),
  ).toBe(CREATED_ORGANIZATION.name);
  return await screen.findByRole("button", {
    name: messages.organization.switchOrganization,
  });
};

const attemptPendingDismissals = (messages: typeof en | typeof ar) => {
  const dialog = screen.getByRole("dialog", {
    name: messages.organization.newOrganization,
  });
  fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
  fireEvent.keyDown(dialog, { key: "Escape", code: "Escape", repeat: true });
  fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
  const backdrop = document.querySelector('[data-slot="dialog-backdrop"]');
  if (backdrop === null) {
    throw new TypeError("An open organization dialog must have a backdrop");
  }
  fireEvent.pointerDown(backdrop, {
    button: 0,
    pointerId: 1,
    pointerType: "mouse",
  });
  fireEvent.mouseDown(backdrop, { button: 0 });
  fireEvent.mouseUp(backdrop, { button: 0 });
  fireEvent.click(backdrop);
  const close = screen.queryByRole("button", { name: en.common.close });
  if (close !== null) {
    fireEvent.click(close);
  }
  const cancel = screen.queryByRole("button", { name: messages.common.cancel });
  if (cancel !== null) {
    fireEvent.click(cancel);
  }
  expect(
    screen.getByRole("dialog", { name: messages.organization.newOrganization }),
  ).toBe(dialog);
};

test.each(
  supportedLanguages.filter((locale) => locale === "en" || locale === "ar"),
)(
  "creation is single-flight and switching needs a separate action in %s",
  async (locale) => {
    const { messages, router, openDialog } = await renderCreationSurface({
      locale,
    });
    await openDialog();
    const response = Promise.withResolvers<Response>();
    deferredCreate = response.promise;
    fillName(messages, "  New firm  ");
    const submit = screen.getByRole("button", {
      name: messages.auth.createOrganizationButton,
    });
    const form = submit.closest("form");
    if (form === null) {
      throw new TypeError("The creation submit button must belong to a form");
    }
    await act(async () => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    await waitFor(() => expect(creationKeys).toHaveLength(1));
    expect(submit.hasAttribute("disabled")).toBe(true);
    response.resolve(createdResponse());
    const switchButton = await expectCreated(messages);
    expect(switchRequests()).toHaveLength(0);
    expect(router.state.location.pathname).toBe("/settings");
    await switchOrganization(switchButton);
    expect(await screen.findByText(messages.common.done)).toBeTruthy();
    expect(requests).toEqual([
      {
        path: "/v1/organizations",
        body: { name: "New firm" },
        capability: "organizations.create",
      },
      {
        path: "/api/auth/organization/set-active",
        body: { organizationId: ORGANIZATION_ID },
        capability: null,
      },
    ]);
    expect(creationKeys.at(0)).toBeTruthy();
    expect(serverReceipts.size).toBe(1);
  },
);

test("closing an edited draft requires confirmation and discards it before reopening", async () => {
  const { messages, openDialog } = await renderCreationSurface();
  const dialog = await openDialog();
  fillName(messages);
  await act(async () => {
    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
    await drainReactScheduler();
  });
  expect(screen.getByRole("dialog")).toBe(dialog);
  expect(
    screen
      .getByRole("textbox", { name: messages.common.organizationName })
      .getAttribute("value"),
  ).toBe("New firm");
  await act(async () => {
    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
    await drainReactScheduler();
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await openDialog();
  expect(
    screen
      .getByRole("textbox", { name: messages.common.organizationName })
      .getAttribute("value"),
  ).toBe("");
  expect(creationKeys).toHaveLength(0);
});

test("a refused creation stays open and can be retried without switching", async () => {
  createOutcome = "refused";
  const { messages, openDialog } = await renderCreationSurface();
  await openDialog();
  fillName(messages);
  createOrganization(messages);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(serverReceipts.size).toBe(0);
  createOutcome = "created";
  createOrganization(messages);
  await expectCreated(messages);
  expect(switchRequests()).toHaveLength(0);
});

test("a refused explicit switch can be retried without creating again", async () => {
  switchOutcome = "refused";
  const { messages, openDialog } = await renderCreationSurface();
  await openDialog();
  fillName(messages);
  createOrganization(messages);
  await switchOrganization(await expectCreated(messages));
  expect(await screen.findByRole("alert")).toBeTruthy();
  switchOutcome = "switched";
  await switchOrganization(
    screen.getByRole("button", {
      name: messages.organization.switchOrganization,
    }),
  );
  expect(await screen.findByText(messages.common.done)).toBeTruthy();
  expect(creationKeys).toHaveLength(1);
  expect(serverReceipts.size).toBe(1);
  expect(switchRequests()).toHaveLength(2);
});

test("the real sidebar organization switcher opens the creation dialog", async () => {
  const { messages, openDialog } = await renderCreationSurface({
    surface: "sidebar",
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  await openDialog();
  expect(
    screen.getByRole("textbox", { name: messages.common.organizationName }),
  ).toBeTruthy();
  expect(requests).toEqual([]);
});

test("pending creation and pending switching ignore every dismissal gesture", async () => {
  const { messages, openDialog } = await renderCreationSurface();
  await openDialog();
  const creation = Promise.withResolvers<Response>();
  deferredCreate = creation.promise;
  fillName(messages);
  createOrganization(messages);
  await waitFor(() => expect(creationKeys).toHaveLength(1));
  attemptPendingDismissals(messages);
  creation.resolve(createdResponse());
  const switchButton = await expectCreated(messages);
  expect(switchRequests()).toHaveLength(0);
  const switching = Promise.withResolvers<Response>();
  deferredSwitch = switching.promise;
  await switchOrganization(switchButton);
  await waitFor(() => expect(switchRequests()).toHaveLength(1));
  attemptPendingDismissals(messages);
  await act(async () => {
    switching.resolve(switchedResponse());
    await drainReactScheduler();
  });
  expect(await screen.findByText(messages.common.done)).toBeTruthy();
  expect(serverReceipts.size).toBe(1);
});

test("a committed creation with a lost response survives sidebar remount and replays the same intent", async () => {
  createOutcome = "response-lost";
  const original = await renderCreationSurface({
    surface: "sidebar",
    queryClient: new QueryClient({
      defaultOptions: {
        mutations: { retry: 1, retryDelay: 0 },
        queries: { retry: false },
      },
    }),
  });
  await original.openDialog();
  const exactDraft = "  New firm  ";
  fillName(original.messages, exactDraft);
  createOrganization(original.messages);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(serverReceipts.size).toBe(1);
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: original.messages.common.cancel }),
    );
    await drainReactScheduler();
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await act(async () => {
    original.unmount();
    await drainReactScheduler();
  });
  const reopened = await renderCreationSurface({
    surface: "sidebar",
    queryClient: original.queryClient,
  });
  await reopened.openDialog();
  expect(
    screen
      .getByRole("textbox", { name: reopened.messages.common.organizationName })
      .getAttribute("value"),
  ).toBe(exactDraft);
  createOutcome = "created";
  createOrganization(reopened.messages);
  await expectCreated(reopened.messages);
  expect(creationKeys).toHaveLength(2);
  expect(creationKeys.at(0)).toBeTruthy();
  expect(creationKeys.at(1)).toBe(creationKeys.at(0));
  expect(serverReceipts.size).toBe(1);
  expect(switchRequests()).toHaveLength(0);
  await switchOrganization(
    screen.getByRole("button", {
      name: reopened.messages.organization.switchOrganization,
    }),
  );
  expect(await screen.findByText(reopened.messages.common.done)).toBeTruthy();
});

test("a creation that completes after leaving the route waits for an explicit switch after reopening", async () => {
  const { router, messages, openDialog } = await renderCreationSurface({
    surface: "sidebar",
  });
  await openDialog();
  const creation = Promise.withResolvers<Response>();
  deferredCreate = creation.promise;
  fillName(messages);
  createOrganization(messages);
  await waitFor(() => expect(creationKeys).toHaveLength(1));
  await act(async () => {
    await router.navigate({ to: "/other" });
    await drainReactScheduler();
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => {
    creation.resolve(createdResponse());
    await creation.promise;
  });
  expect(router.state.location.pathname).toBe("/other");
  expect(switchRequests()).toHaveLength(0);
  await act(async () => {
    await router.navigate({ to: "/settings" });
    await drainReactScheduler();
  });
  await openDialog();
  const switchButton = await expectCreated(messages);
  expect(router.state.location.pathname).toBe("/settings");
  expect(creationKeys).toHaveLength(1);
  expect(serverReceipts.size).toBe(1);
  expect(switchRequests()).toHaveLength(0);
  await switchOrganization(switchButton);
  expect(await screen.findByText(messages.common.done)).toBeTruthy();
  expect(switchRequests()).toHaveLength(1);
});

const UNKNOWN_CREATION_OUTCOMES = {
  network: () => {
    throw new TypeError("The creation response was lost");
  },
  timeout: () => {
    throw new DOMException("The creation response timed out", "TimeoutError");
  },
  server: () =>
    Response.json(
      {
        code: "organization_slug_conflict",
        message: "Private server error sentinel",
      },
      { status: 500 },
    ),
  unparsableRefusal: () =>
    new Response("not JSON", {
      status: 400,
      headers: { "Content-Type": "application/json" },
    }),
  unparsableSuccess: () =>
    new Response("not JSON", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  unclassifiedRefusal: () =>
    Response.json({ message: "Unclassified server message" }, { status: 403 }),
  pendingReceipt: () =>
    Response.json(
      {
        code: IDEMPOTENCY_IN_PROGRESS_CODE,
        message: "The creation is still pending",
      },
      { status: 409 },
    ),
};

test.each(Object.entries(UNKNOWN_CREATION_OUTCOMES))(
  "an unknown %s creation outcome locks the name and reuses its receipt on retry",
  async (_outcome, respond) => {
    unknownFailureResponse = respond;
    const { messages, openDialog } = await renderCreationSurface();
    await openDialog();
    const exactDraft = "  New firm  ";
    fillName(messages, exactDraft);
    createOrganization(messages);
    expect((await screen.findByRole("alert")).textContent).toContain(
      messages.organization.creationOutcomeUnknown,
    );
    const input = screen.getByRole("textbox", {
      name: messages.common.organizationName,
    });
    expect(
      input.hasAttribute("disabled") || input.hasAttribute("readonly"),
    ).toBe(true);
    expect(input.getAttribute("value")).toBe(exactDraft);
    expect(creationKeys).toHaveLength(1);
    expect(serverReceipts.size).toBe(1);
    createOrganization(messages);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(creationKeys).toHaveLength(2);
    expect(creationKeys.at(1)).toBe(creationKeys.at(0));
    expect(serverReceipts.size).toBe(1);
    unknownFailureResponse = undefined;
    createOrganization(messages);
    await expectCreated(messages);
    expect(creationKeys).toHaveLength(3);
    expect(creationKeys.at(2)).toBe(creationKeys.at(0));
    expect(serverReceipts.size).toBe(1);
    expect(switchRequests()).toHaveLength(0);
  },
);

const TYPED_CREATION_REFUSALS = {
  accountAccess: {
    code: "account_access_unavailable",
    status: 403,
    messageKey: "organization.creationNotAllowed",
  },
  evaluationLimit: {
    code: ORGANIZATION_EVALUATION_LIMIT_REACHED_CODE,
    status: 403,
    messageKey: "organization.creationEvaluationLimitReached",
  },
  rateLimit: {
    code: "rate_limited",
    status: 429,
    messageKey: "organization.creationRateLimited",
  },
  validationLegacy: {
    code: API_VALIDATION_ERROR_CODE,
    status: 400,
    messageKey: "organization.creationInvalidName",
  },
  validation: {
    code: API_VALIDATION_ERROR_CODE,
    status: 422,
    messageKey: "organization.creationInvalidName",
  },
  slugConflict: {
    code: "organization_slug_conflict",
    status: 409,
    messageKey: "organization.creationSlugConflict",
  },
  otherTypedRefusal: {
    code: "custom_refusal",
    status: 409,
    messageKey: "organization.creationRefused",
  },
} as const satisfies Record<
  string,
  { code: string; status: number; messageKey: TranslationKey }
>;

test.each(
  Object.entries(TYPED_CREATION_REFUSALS).flatMap(([label, refusal]) =>
    supportedLanguages
      .filter((locale) => locale === "en" || locale === "ar")
      .map((locale) => [label, locale, refusal] as const),
  ),
)(
  "a definite %s refusal in %s retains an editable draft across remount and creates a new intent on resubmission",
  async (_label, locale, refusal) => {
    refusalResponse = refusal;
    const original = await renderCreationSurface({ locale });
    await original.openDialog();
    const exactDraft = "  New firm  ";
    fillName(original.messages, exactDraft);
    createOrganization(original.messages);
    const alert = await screen.findByRole("alert");
    const t = createTranslator({ locale, messages: original.messages });
    const localizedMessage = t(refusal.messageKey, {
      maxLength: ORGANIZATION_NAME_MAX_LENGTH,
      limit: ORGANIZATION_EVALUATION_LIMIT,
    });
    expect(alert.textContent).toContain(localizedMessage);
    expect(alert.textContent).not.toContain(
      "Untranslated server refusal sentinel",
    );
    let input = screen.getByRole("textbox", {
      name: original.messages.common.organizationName,
    });
    expect(input.hasAttribute("disabled")).toBe(false);
    expect(input.hasAttribute("readonly")).toBe(false);
    expect(input.getAttribute("value")).toBe(exactDraft);
    expect(creationKeys).toHaveLength(1);
    expect(serverReceipts.size).toBe(0);
    fireEvent.click(
      screen.getByRole("button", { name: original.messages.common.cancel }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => {
      original.unmount();
      await drainReactScheduler();
    });
    const reopened = await renderCreationSurface({
      locale,
      queryClient: original.queryClient,
    });
    await reopened.openDialog();
    input = screen.getByRole("textbox", {
      name: reopened.messages.common.organizationName,
    });
    expect(input.hasAttribute("disabled")).toBe(false);
    expect(input.hasAttribute("readonly")).toBe(false);
    expect(input.getAttribute("value")).toBe(exactDraft);
    expect((await screen.findByRole("alert")).textContent).toContain(
      localizedMessage,
    );
    refusalResponse = undefined;
    createOrganization(reopened.messages);
    await expectCreated(reopened.messages);
    expect(creationKeys).toHaveLength(2);
    expect(creationKeys.at(0)).toBeTruthy();
    expect(creationKeys.at(1)).not.toBe(creationKeys.at(0));
    expect(serverReceipts.size).toBe(1);
    expect(switchRequests()).toHaveLength(0);
  },
);

test("starting over after an unknown outcome requires confirmation and preserves the old intent when canceled", async () => {
  createOutcome = "response-lost";
  const { messages, openDialog } = await renderCreationSurface();
  await openDialog();

  const exactDraft = "  New firm  ";
  fillName(messages, exactDraft);
  createOrganization(messages);

  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(serverReceipts.size).toBe(1);
  act(() => {
    const button = screen.getByRole("button", {
      name: messages.organization.startOver,
    });
    button.focus();
    fireEvent.click(button);
  });

  const firstConfirmation = await screen.findByRole("dialog", {
    name: messages.organization.startOverTitle,
  });

  expect(
    within(firstConfirmation).getByText(
      messages.organization.startOverDescription,
    ),
  ).toBeTruthy();
  act(() => {
    const button = within(firstConfirmation).getByRole("button", {
      name: messages.common.cancel,
    });
    button.focus();
    fireEvent.click(button);
  });

  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", {
        name: messages.organization.startOverTitle,
      }),
    ).toBeNull(),
  );

  let input = screen.getByRole("textbox", {
    name: messages.common.organizationName,
  });
  expect(input.hasAttribute("disabled") || input.hasAttribute("readonly")).toBe(
    true,
  );
  expect(input.getAttribute("value")).toBe(exactDraft);

  createOrganization(messages);

  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(creationKeys).toHaveLength(2);
  expect(creationKeys.at(1)).toBe(creationKeys.at(0));
  expect(serverReceipts.size).toBe(1);
  act(() => {
    const button = screen.getByRole("button", {
      name: messages.organization.startOver,
    });
    button.focus();
    fireEvent.click(button);
  });
  const secondConfirmation = await screen.findByRole("dialog", {
    name: messages.organization.startOverTitle,
  });
  expect(
    within(secondConfirmation).getByText(
      messages.organization.startOverDescription,
    ),
  ).toBeTruthy();
  act(() => {
    const button = within(secondConfirmation).getByRole("button", {
      name: messages.organization.startOver,
    });
    button.focus();
    fireEvent.click(button);
  });
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", {
        name: messages.organization.startOverTitle,
      }),
    ).toBeNull(),
  );
  input = screen.getByRole("textbox", {
    name: messages.common.organizationName,
  });
  expect(input.hasAttribute("disabled")).toBe(false);
  expect(input.hasAttribute("readonly")).toBe(false);
  expect(input.getAttribute("value")).toBe(exactDraft);
  createOutcome = "created";
  createOrganization(messages);
  expect(await screen.findByText("new-firm-2")).toBeTruthy();
  expect(creationKeys).toHaveLength(3);
  expect(creationKeys.at(2)).not.toBe(creationKeys.at(0));
  expect(serverReceipts.size).toBe(2);
  expect(
    new Set(
      [...serverReceipts.values()].map(({ organizationId }) => organizationId),
    ).size,
  ).toBe(2);
  expect(switchRequests()).toHaveLength(0);
});
