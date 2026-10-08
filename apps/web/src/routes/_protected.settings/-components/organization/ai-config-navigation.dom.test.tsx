import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import messages from "@/i18n/langs/en.json";
import type { OrganizationAIConfig } from "@/lib/organization/ai-config-queries";

GlobalRegistrator.register({
  url: "http://localhost:3000/settings/organization",
});
const originalFetch = globalThis.fetch;
const requests: string[] = [];
const requestBodies: string[] = [];
const config = {
  configured: false,
  instanceProvisioned: false,
  decisionInstanceProvisioned: false,
} satisfies OrganizationAIConfig;
const savedConfig = {
  configured: true,
  instanceProvisioned: false,
  decisionInstanceProvisioned: false,
  providers: [
    { provider: "google", apiKeyMasked: "AIza****1234", region: "global" },
  ],
  overrideModels: null,
  decision: null,
} satisfies OrganizationAIConfig;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(`${init?.method ?? "GET"} ${url}`);
    requestBodies.push(
      input instanceof Request
        ? await input.clone().text()
        : await new Response(init?.body).text(),
    );
    if (url.includes("organization-settings/ai-config")) {
      return Response.json(savedConfig);
    }
    return Response.json({ models: [] });
  },
  { preconnect: originalFetch.preconnect },
);

const { act } = await import("react");
const { cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { AIConfigForm } = await import("./ai-config-card");
const { hasUnsavedWork } = await import("@/hooks/use-unsaved-work");
const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  requests.length = 0;
  requestBodies.length = 0;
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await GlobalRegistrator.unregister();
});

const mount = async (initialConfig: OrganizationAIConfig = config) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const root = router.createRootRoute({ component: router.Outlet });
  const settings = router.createRoute({
    getParentRoute: () => root,
    path: "/settings/organization",
    component: () => (
      <AIConfigForm
        config={initialConfig}
        organizationId="byok-navigation-fixture"
      />
    ),
  });
  const destination = router.createRoute({
    getParentRoute: () => root,
    path: "/left",
    component: () => <p>{messages.common.done}</p>,
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({
      initialEntries: ["/settings/organization"],
    }),
    isServer: false,
    routeTree: root.addChildren([settings, destination]),
  });
  await appRouter.load();
  render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <router.RouterProvider router={appRouter} />
      </IntlProvider>
    </QueryClientProvider>,
  );
  if (initialConfig.configured) {
    await screen.findAllByRole("button", {
      name: messages.organization.aiConfig.removeProvider,
    });
  } else {
    await screen.findByLabelText(messages.organization.aiConfig.apiKey);
  }
  return appRouter;
};
const dirtyKey = () =>
  fireEvent.change(
    screen.getByLabelText(messages.organization.aiConfig.apiKey),
    { target: { value: `AIza${"a".repeat(31)}1234` } },
  );

test("leaving AI provider settings with a dirty key prompts before navigation", async () => {
  const appRouter = await mount();
  dirtyKey();
  expect(screen.getByText(messages.common.unsavedChanges)).toBeDefined();
  await act(async () => {
    void appRouter.navigate({ to: "/left" });
  });
  expect(await screen.findByRole("alertdialog")).toBeDefined();
  expect(screen.getByText(messages.common.unsavedLeaveConfirm)).toBeDefined();
  expect(appRouter.state.location.pathname).toBe("/settings/organization");
});

test("leaving clean AI provider settings proceeds without a prompt", async () => {
  const appRouter = await mount();
  expect(hasUnsavedWork()).toBe(false);
  await act(async () => {
    await appRouter.navigate({ to: "/left" });
  });
  expect(await screen.findByText(messages.common.done)).toBeDefined();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

test("saving the key clears the navigation prompt", async () => {
  const appRouter = await mount();
  dirtyKey();
  fireEvent.click(screen.getByRole("button", { name: messages.common.save }));
  await screen.findByText(messages.organization.aiConfig.savedVerified);
  expect(
    requests.some(
      (request) =>
        request.startsWith("POST ") &&
        request.includes("organization-settings/ai-config"),
    ),
  ).toBe(true);
  expect(hasUnsavedWork()).toBe(false);
  await act(async () => {
    await appRouter.navigate({ to: "/left" });
  });
  expect(await screen.findByText(messages.common.done)).toBeDefined();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

test("cancelling the leave prompt retains the edited key and settings route", async () => {
  const appRouter = await mount();
  dirtyKey();
  await act(async () => {
    void appRouter.navigate({ to: "/left" });
  });
  const dialog = await screen.findByRole("alertdialog");
  expect(Object.hasOwn(dialog.dataset, "open")).toBe(true);
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: messages.common.goBackToEditing }),
    );
  });
  await waitFor(() =>
    expect(Object.hasOwn(dialog.dataset, "open")).toBe(false),
  );
  expect(appRouter.state.location.pathname).toBe("/settings/organization");
  expect(
    screen.getByLabelText(messages.organization.aiConfig.apiKey),
  ).toHaveProperty("value", `AIza${"a".repeat(31)}1234`);
  expect(hasUnsavedWork()).toBe(true);
});

test("removing one saved provider posts only the remaining stored credentials", async () => {
  await mount({
    ...savedConfig,
    providers: [
      ...savedConfig.providers,
      {
        provider: "openrouter",
        apiKeyMasked: "sk-or-v1****5678",
        region: "global",
      },
    ],
  });
  const removeButtons = screen.getAllByRole("button", {
    name: messages.organization.aiConfig.removeProvider,
  });
  expect(removeButtons).toHaveLength(2);
  fireEvent.click(removeButtons[1]);
  await waitFor(() =>
    expect(screen.queryByText("sk-or-v1****5678") === null).toBe(true),
  );
  expect(screen.getByText("AIza****1234")).toBeDefined();
  const writes = requests.filter(
    (request) => request.startsWith("POST ") || request.startsWith("DELETE "),
  );
  expect(writes).toHaveLength(1);
  expect(writes.at(0)).toContain("POST ");
  const body = requestBodies.at(
    requests.findIndex((request) => request.startsWith("POST ")),
  );
  expect(body).toContain('"providers":[{"provider":"google"');
  expect(body).not.toContain('"provider":"openrouter"');
  expect(body).not.toContain("apiKeyMasked");
  expect(body).not.toContain('"apiKey":');
});

test("removing the last saved provider deletes the configuration", async () => {
  await mount(savedConfig);
  fireEvent.click(
    screen.getByRole("button", {
      name: messages.organization.aiConfig.removeProvider,
    }),
  );
  await waitFor(() =>
    expect(screen.queryByText("AIza****1234") === null).toBe(true),
  );
  const writes = requests.filter(
    (request) => request.startsWith("POST ") || request.startsWith("DELETE "),
  );
  expect(writes).toHaveLength(1);
  expect(writes.at(0)).toContain("DELETE ");
  expect(
    screen.queryByRole("button", {
      name: messages.organization.aiConfig.removeProvider,
    }),
  ).toBeNull();
  expect(hasUnsavedWork()).toBe(false);
});
