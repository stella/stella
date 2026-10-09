import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import {
  BYOK_DEFAULT_MODELS,
  DECISION_MODEL_CATALOG,
  DECISION_MODEL_PROVIDERS,
} from "@stll/ai-catalog";
import { sleep } from "@stll/concurrency/sleep";

import { getModelOptionsForRole } from "@/components/ai-config-role-models.logic";
import messages from "@/i18n/langs/en.json";
import type { OrganizationAIConfig } from "@/lib/organization/ai-config-queries";

GlobalRegistrator.register({
  url: "http://localhost:3000/settings/organization",
});
const originalFetch = globalThis.fetch;
const requests: { method: string; url: string; body: string }[] = [];
let settingsFailure: { code: string; message: string } | undefined;
let reflectProviderOrder = false;
const ORGANIZATION = "byok-navigation-fixture";
let sessionOrganization = ORGANIZATION;
let auxiliaryFailure: { path: string; message: string } | undefined;
let organizationSettings = {
  promptCachingEnabled: false,
  documentProcessingMode: "off",
  memoryExtractionEnabled: false,
};
const GOOGLE_KEY = `AIza${"a".repeat(31)}1234`;
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
  overrideModels: {
    chat: {
      provider: "google",
      modelId: BYOK_DEFAULT_MODELS.google.chat.modelId,
    },
    fast: {
      provider: "google",
      modelId: BYOK_DEFAULT_MODELS.google.fast.modelId,
    },
    reasoning: {
      provider: "google",
      modelId: BYOK_DEFAULT_MODELS.google.reasoning.modelId,
    },
    pdf: {
      provider: "google",
      modelId: BYOK_DEFAULT_MODELS.google.pdf.modelId,
    },
  },
  decision: null,
} satisfies OrganizationAIConfig;
let responseConfig: OrganizationAIConfig = savedConfig;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    let body = "";
    if (init?.body !== undefined) {
      body = await new Response(init.body).text();
    } else if (input instanceof Request) {
      body = await input.clone().text();
    }
    requests.push({ method, url, body });
    const pathname = new URL(url, "http://localhost:3000").pathname;
    if (pathname.endsWith("/auth/get-session")) {
      return Response.json({
        session: { userId: "user", activeOrganizationId: sessionOrganization },
        user: { id: "user", email: "admin@example.test", name: "Admin" },
      });
    }
    if (
      auxiliaryFailure &&
      pathname.endsWith(auxiliaryFailure.path) &&
      method !== "GET"
    ) {
      return Response.json(
        {
          code: "settings_validation_failed",
          message: auxiliaryFailure.message,
        },
        { status: 400 },
      );
    }
    if (pathname.endsWith("/deepl-config")) {
      return Response.json({ configured: false });
    }
    if (pathname.endsWith("/web-search-config")) {
      return Response.json({
        search: { configured: false, platformFallback: true },
        fetch: { configured: false, platformFallback: true },
      });
    }
    if (pathname.endsWith("/deepl") || pathname.endsWith("/web-search-key")) {
      return Response.json({ configured: true });
    }
    if (pathname.endsWith("/organization-settings")) {
      if (method === "POST") {
        organizationSettings = { ...organizationSettings, ...JSON.parse(body) };
      }
      return Response.json(organizationSettings);
    }
    if (url.includes("organization-settings/ai-config")) {
      if (
        settingsFailure !== undefined &&
        (method === "POST" || method === "DELETE")
      ) {
        return Response.json(settingsFailure, { status: 400 });
      }
      const configuredResponse = responseConfig;
      if (
        reflectProviderOrder &&
        method === "POST" &&
        configuredResponse.configured
      ) {
        const configurationRequest: unknown = JSON.parse(body);
        if (
          typeof configurationRequest !== "object" ||
          configurationRequest === null ||
          !("providers" in configurationRequest) ||
          !Array.isArray(configurationRequest.providers)
        ) {
          panic("Expected provider configuration request");
        }
        return Response.json({
          ...configuredResponse,
          providers: configurationRequest.providers.map(
            (candidate: unknown) => {
              if (
                typeof candidate !== "object" ||
                candidate === null ||
                !("provider" in candidate)
              ) {
                panic("Expected provider input");
              }
              return (
                configuredResponse.providers.find(
                  ({ provider }) => provider === candidate.provider,
                ) ?? panic("Provider response fixture missing")
              );
            },
          ),
        });
      }
      return Response.json(responseConfig);
    }
    return Response.json({ models: [] });
  },
  { preconnect: originalFetch.preconnect },
);

const { act, useState } = await import("react");
const { cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
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
  settingsFailure = undefined;
  auxiliaryFailure = undefined;
  sessionOrganization = ORGANIZATION;
  organizationSettings = {
    promptCachingEnabled: false,
    documentProcessingMode: "off",
    memoryExtractionEnabled: false,
  };
  reflectProviderOrder = false;
  responseConfig = savedConfig;
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  cleanup();
  await act(async () => await sleep(50));
  await GlobalRegistrator.unregister();
});

type AIConfigReadState = Parameters<typeof AIConfigForm>[0]["readState"];

const mount = async (
  initialConfig: OrganizationAIConfig = config,
  initialReadState?: AIConfigReadState,
) => {
  const readState: AIConfigReadState = initialReadState ?? {
    status: "ready",
    config: initialConfig,
  };
  responseConfig = {
    ...savedConfig,
    overrideModels: initialConfig.configured
      ? initialConfig.overrideModels
      : null,
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const SettingsRoute = () => {
    const [currentReadState, setReadState] = useState(readState);
    const formReadState =
      currentReadState.status === "unreadable"
        ? ({
            status: "unreadable",
            onRetry: () => {
              currentReadState.onRetry();
              setReadState({ status: "ready", config: initialConfig });
            },
          } as const)
        : currentReadState;
    return (
      <AIConfigForm readState={formReadState} organizationId={ORGANIZATION} />
    );
  };
  const root = router.createRootRoute({ component: router.Outlet });
  const settings = router.createRoute({
    getParentRoute: () => root,
    path: "/settings/organization",
    component: SettingsRoute,
  });
  const destination = router.createRoute({
    getParentRoute: () => root,
    path: "/settings",
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
      <AuthenticatedUserProvider
        user={{
          activeOrganizationId: ORGANIZATION,
          id: "user",
          email: "admin@example.test",
          image: null,
          name: "Admin",
          preferredName: null,
          timezoneId: "UTC",
          wordEditShortcut: null,
        }}
      >
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <router.RouterProvider router={appRouter} />
        </IntlProvider>
      </AuthenticatedUserProvider>
    </QueryClientProvider>,
  );
  if (readState.status === "unreadable") {
    await screen.findByText(messages.common.somethingWentWrong);
  } else if (initialConfig.configured) {
    await screen.findAllByRole("button", {
      name: messages.organization.aiConfig.removeProvider,
    });
  } else {
    await waitFor(() =>
      expect(
        providerQueries().getByLabelText(messages.organization.aiConfig.apiKey),
      ).toBeDefined(),
    );
  }
  await screen.findByRole("heading", {
    name: messages.translate.settings.title,
  });
  await deeplQueries().findByLabelText(messages.translate.settings.apiKeyLabel);
  await screen.findByRole("checkbox", {
    name: messages.settings.organization.promptCaching.toggleLabel,
  });
  await waitFor(() => {
    expect(document.querySelector("#web-search-key-search")).not.toBeNull();
    expect(document.querySelector("#web-search-key-fetch")).not.toBeNull();
  });
  return appRouter;
};
const providerQueries = () => {
  const section = screen
    .getByRole("heading", {
      name: messages.organization.aiConfig.providersPanel,
    })
    .closest("section");
  if (section === null) {
    panic("Provider section must be present");
  }
  return within(section);
};
const settingsSectionQueries = (title: string) => {
  const heading = screen.getByRole("heading", { name: title });
  const section =
    heading.tagName === "H3"
      ? heading.parentElement?.parentElement
      : heading.parentElement;
  if (!section) {
    panic("Settings section must contain its heading");
  }
  return within(section);
};

const deeplQueries = () =>
  settingsSectionQueries(messages.translate.settings.title);

const writes = () =>
  requests.filter(({ method }) => method === "POST" || method === "DELETE");
const savePage = () =>
  fireEvent.click(
    screen.getByRole("button", { name: messages.common.saveChanges }),
  );
const dirtyKey = () =>
  fireEvent.change(
    providerQueries().getByLabelText(messages.organization.aiConfig.apiKey),
    { target: { value: GOOGLE_KEY } },
  );

test("leaving AI provider settings with a dirty key prompts before navigation", async () => {
  const appRouter = await mount();
  dirtyKey();
  expect(screen.getByText(messages.common.unsavedChanges)).toBeDefined();
  await act(async () => {
    void appRouter.navigate({ to: "/settings" });
  });
  expect(await screen.findByRole("alertdialog")).toBeDefined();
  expect(screen.getByText(messages.common.unsavedLeaveConfirm)).toBeDefined();
  expect(appRouter.state.location.pathname).toBe("/settings/organization");
});

test("leaving clean AI provider settings proceeds without a prompt", async () => {
  const appRouter = await mount();
  expect(hasUnsavedWork()).toBe(false);
  await act(async () => {
    await appRouter.navigate({ to: "/settings" });
  });
  expect(await screen.findByText(messages.common.done)).toBeDefined();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

test("saving the key clears the navigation prompt", async () => {
  const appRouter = await mount();
  dirtyKey();
  fireEvent.click(
    screen.getByRole("button", { name: messages.common.saveChanges }),
  );
  await waitFor(() => expect(hasUnsavedWork()).toBe(false));
  expect(screen.getByText("AIza****1234")).toBeDefined();
  expect(
    providerQueries().queryByLabelText(messages.organization.aiConfig.apiKey),
  ).toBeNull();
  expect(document.body.innerHTML).not.toContain(GOOGLE_KEY);
  const savedWrites = requests.filter(
    ({ method }) => method === "POST" || method === "DELETE",
  );
  expect(savedWrites).toHaveLength(1);
  expect(savedWrites.at(0)?.method).toBe("POST");
  expect(savedWrites.at(0)?.body).toContain(
    `"providers":${JSON.stringify([{ provider: "google", apiKey: GOOGLE_KEY, region: "global" }])}`,
  );
  expect(
    requests.some(
      (request) =>
        request.method === "POST" &&
        request.url.includes("organization-settings/ai-config"),
    ),
  ).toBe(true);
  expect(hasUnsavedWork()).toBe(false);
  await act(async () => {
    await appRouter.navigate({ to: "/settings" });
  });
  expect(await screen.findByText(messages.common.done)).toBeDefined();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

test("cancelling the leave prompt retains the edited key and settings route", async () => {
  const appRouter = await mount();
  dirtyKey();
  await act(async () => {
    void appRouter.navigate({ to: "/settings" });
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
    providerQueries().getByLabelText(messages.organization.aiConfig.apiKey),
  ).toHaveProperty("value", GOOGLE_KEY);
  expect(hasUnsavedWork()).toBe(true);
});

test("clearing a draft workspace ID back to absent clears row dirty state and the leave prompt", async () => {
  const appRouter = await mount();
  fireEvent.click(
    screen.getByRole("button", {
      name: messages.organization.aiConfig.addProvider,
    }),
  );
  const input = providerQueries()
    .getAllByLabelText(messages.organization.aiConfig.apiKey)
    .at(1);
  if (input === undefined) {
    panic("Anthropic draft key input must be present");
  }
  fireEvent.change(input, { target: { value: "sk-ant-usr-fixture" } });
  const workspace = screen.getByLabelText(
    messages.organization.aiConfig.anthropicWorkspaceId,
  );
  fireEvent.change(workspace, { target: { value: "wrkspc_fixture" } });
  fireEvent.change(input, { target: { value: "" } });
  expect(screen.getByText(messages.common.unsavedChanges)).toBeDefined();
  expect(hasUnsavedWork()).toBe(true);
  fireEvent.change(workspace, { target: { value: "" } });
  expect(screen.queryByText(messages.common.unsavedChanges)).toBeNull();
  expect(hasUnsavedWork()).toBe(false);
  expect(
    requests.filter(({ method }) => method === "POST" || method === "DELETE"),
  ).toEqual([]);
  await act(async () => {
    await appRouter.navigate({ to: "/settings" });
  });
  expect(await screen.findByText(messages.common.done)).toBeDefined();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

test("Advanced shows catalog defaults, saves only explicit overrides and resets them", async () => {
  const defaults = {
    ...savedConfig,
    overrideModels: null,
  } satisfies OrganizationAIConfig;
  responseConfig = defaults;
  await mount(defaults);
  const advanced = screen.getByRole("button", {
    name: messages.common.advanced,
  });
  expect(advanced.getAttribute("aria-expanded")).toBe("false");
  expect(
    screen.queryByText(messages.organization.aiConfig.modelsPanel),
  ).toBeNull();
  expect(screen.queryByText(messages.common.custom)).toBeNull();
  fireEvent.click(advanced);
  const modelLabel = messages.organization.aiConfig.modelForRole.replace(
    "{role}",
    () => messages.organization.aiConfig.roles.chat,
  );
  const model = await screen.findByLabelText(modelLabel);
  expect(model).toHaveProperty(
    "value",
    BYOK_DEFAULT_MODELS.google.chat.modelId,
  );
  expect(
    screen
      .getAllByRole("group")
      .filter((row) =>
        row.textContent.includes(messages.organization.aiConfig.usingDefaults),
      ),
  ).toHaveLength(5);
  expect(
    screen.getByText(messages.organization.aiConfig.defaultRationale.chat),
  ).toBeDefined();
  const overrideId = getModelOptionsForRole({
    provider: "google",
    role: "chat",
  }).find((modelId) => modelId !== BYOK_DEFAULT_MODELS.google.chat.modelId);
  if (overrideId === undefined) {
    panic("Google chat must offer an alternate model");
  }
  act(() => model.focus());
  fireEvent.change(model, { target: { value: overrideId } });
  fireEvent.keyDown(model, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: overrideId }));
  expect(hasUnsavedWork()).toBe(true);
  fireEvent.click(advanced);
  expect(hasUnsavedWork()).toBe(true);
  fireEvent.click(advanced);
  responseConfig = {
    ...defaults,
    overrideModels: { chat: { provider: "google", modelId: overrideId } },
  };
  fireEvent.click(
    screen.getByRole("button", { name: messages.common.saveChanges }),
  );
  await waitFor(() => expect(hasUnsavedWork()).toBe(false));
  const write = requests.find(({ method }) => method === "POST");
  expect(JSON.parse(write?.body ?? "null")).toMatchObject({
    overrideModels: { chat: { provider: "google", modelId: overrideId } },
  });
  expect(JSON.parse(write?.body ?? "null").overrideModels).toEqual({
    chat: { provider: "google", modelId: overrideId },
  });
  fireEvent.click(advanced);
  expect(advanced.textContent).toContain(messages.common.custom);
  expect(screen.queryByLabelText(modelLabel)).toBeNull();
  fireEvent.click(advanced);
  fireEvent.click(
    await screen.findByRole("button", { name: messages.common.resetToDefault }),
  );
  expect(screen.getByLabelText(modelLabel)).toHaveProperty(
    "value",
    BYOK_DEFAULT_MODELS.google.chat.modelId,
  );
  responseConfig = defaults;
  fireEvent.click(
    screen.getByRole("button", { name: messages.common.saveChanges }),
  );
  await waitFor(() => expect(hasUnsavedWork()).toBe(false));
  expect(
    requests.filter(({ method }) => method === "POST").at(1)?.body,
  ).toContain('"overrideModels":null');
  expect(advanced.textContent).not.toContain(messages.common.custom);
});

test("provider title and trailing add action share the section header", async () => {
  await mount();
  const title = screen.getByText(messages.organization.aiConfig.providersPanel);
  const add = screen.getByRole("button", {
    name: messages.organization.aiConfig.addProvider,
  });
  expect(title.parentElement).toBe(add.parentElement);
  expect(title.parentElement?.className).toContain(
    "grid-cols-[minmax(0,1fr)_auto]",
  );
  expect(title.parentElement?.className).toContain("items-center");
  expect(
    screen.getByText(messages.organization.aiConfig.providersDescription)
      .parentElement,
  ).toBe(title.parentElement);
});

test("stored overrides keep Advanced collapsed and mark Custom even when equal to defaults", async () => {
  await mount(savedConfig);
  const advanced = screen.getByRole("button", {
    name: new RegExp(messages.common.advanced, "u"),
  });
  expect(advanced.getAttribute("aria-expanded")).toBe("false");
  expect(advanced.textContent).toContain(messages.common.custom);
  expect(
    screen.queryByText(messages.organization.aiConfig.modelsPanel),
  ).toBeNull();
});

test.each([false, true])(
  "Advanced hides unavailable Mistral PDF controls (fallback provider: %s)",
  async (withFallback) => {
    const mistral = {
      provider: "mistral",
      apiKeyMasked: "****1234",
      region: "global",
    } as const;
    const openai = {
      provider: "openai",
      apiKeyMasked: "sk-****5678",
      region: "global",
    } as const;
    await mount({
      ...savedConfig,
      providers: withFallback ? [mistral, openai] : [mistral],
      overrideModels: null,
    });
    fireEvent.click(
      screen.getByRole("button", { name: messages.common.advanced }),
    );
    expect(
      await screen.findByText(
        messages.organization.aiConfig.roleUnavailable.replace(
          "{provider}",
          "Mistral",
        ),
      ),
    ).toBeDefined();
    const pdfLabel = messages.organization.aiConfig.modelForRole.replace(
      "{role}",
      () => messages.organization.aiConfig.roles.pdf,
    );
    if (withFallback) {
      expect(screen.getByLabelText(pdfLabel)).toHaveProperty(
        "value",
        BYOK_DEFAULT_MODELS.openai.pdf.modelId,
      );
    } else {
      expect(screen.queryByLabelText(pdfLabel)).toBeNull();
      expect(
        screen.queryByLabelText(
          messages.organization.aiConfig.providerForRole.replace(
            "{role}",
            () => messages.organization.aiConfig.roles.pdf,
          ),
        ),
      ).toBeNull();
    }
  },
);

test("replacing the first saved key preserves provider order and every default role provider", async () => {
  const twoProviders = {
    ...savedConfig,
    providers: [
      ...savedConfig.providers,
      {
        provider: "anthropic",
        apiKeyMasked: "sk-ant-api03****5678",
        region: "global",
      },
    ],
    overrideModels: null,
  } satisfies OrganizationAIConfig;
  await mount(twoProviders);
  responseConfig = twoProviders;
  reflectProviderOrder = true;
  fireEvent.click(
    screen.getByRole("button", { name: messages.common.advanced }),
  );
  const providerLabels = Object.values(
    messages.organization.aiConfig.roles,
  ).map((role) =>
    messages.organization.aiConfig.providerForRole.replace(
      "{role}",
      () => role,
    ),
  );
  for (const label of providerLabels) {
    expect(screen.getByLabelText(label).textContent).toContain("Google");
  }
  const replace = screen
    .getAllByRole("button", { name: messages.organization.aiConfig.replaceKey })
    .at(0);
  if (replace === undefined) {
    panic("First saved provider must offer replacement");
  }
  fireEvent.click(replace);
  dirtyKey();
  fireEvent.click(
    screen.getByRole("button", { name: messages.common.saveChanges }),
  );
  await waitFor(() => expect(hasUnsavedWork()).toBe(false));
  for (const label of providerLabels) {
    expect(screen.getByLabelText(label).textContent).toContain("Google");
  }
  const write = requests.find(({ method }) => method === "POST");
  expect(JSON.parse(write?.body ?? "null")).toMatchObject({
    providers: [
      { provider: "google", apiKey: GOOGLE_KEY },
      { provider: "anthropic" },
    ],
  });
  expect(JSON.parse(write?.body ?? "null").overrideModels).toBeNull();
  expect(hasUnsavedWork()).toBe(false);
});

test("resetting and reselecting the saved override clears dirty state and the leave prompt", async () => {
  const modelId = getModelOptionsForRole({
    provider: "google",
    role: "chat",
  }).find((candidate) => candidate !== BYOK_DEFAULT_MODELS.google.chat.modelId);
  if (modelId === undefined) {
    panic("Google chat must offer an alternate model");
  }
  const appRouter = await mount({
    ...savedConfig,
    overrideModels: {
      chat: { provider: "google", modelId },
      fast: {
        provider: "google",
        modelId: BYOK_DEFAULT_MODELS.google.fast.modelId,
      },
    },
  });
  fireEvent.click(
    screen.getByRole("button", {
      name: new RegExp(messages.common.advanced, "u"),
    }),
  );
  const resetChat = screen
    .getAllByRole("button", { name: messages.common.resetToDefault })
    .at(0);
  if (resetChat === undefined) {
    panic("Chat override must offer reset");
  }
  fireEvent.click(resetChat);
  expect(hasUnsavedWork()).toBe(true);
  const label = messages.organization.aiConfig.modelForRole.replace(
    "{role}",
    () => messages.organization.aiConfig.roles.chat,
  );
  const model = screen.getByLabelText(label);
  expect(model).toHaveProperty(
    "value",
    BYOK_DEFAULT_MODELS.google.chat.modelId,
  );
  act(() => model.focus());
  fireEvent.change(model, { target: { value: modelId } });
  fireEvent.keyDown(model, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: modelId }));
  expect(model).toHaveProperty("value", modelId);
  expect(hasUnsavedWork()).toBe(false);
  expect(screen.queryByText(messages.common.unsavedChanges)).toBeNull();
  expect(
    requests.filter(({ method }) => method === "POST" || method === "DELETE"),
  ).toEqual([]);
  await act(async () => {
    await appRouter.navigate({ to: "/settings" });
  });
  expect(await screen.findByText(messages.common.done)).toBeDefined();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

const decisionRow = () =>
  screen.getByRole("group", {
    name: messages.organization.aiConfig.decision.label,
  });

const selectDecisionProvider = async () => {
  const provider = DECISION_MODEL_PROVIDERS.at(0);
  if (provider === undefined) {
    panic("Decision catalogue must offer a provider");
  }
  fireEvent.click(
    within(decisionRow()).getByLabelText(
      messages.organization.aiConfig.providerForRole.replace(
        "{role}",
        () => messages.organization.aiConfig.decision.label,
      ),
    ),
  );
  fireEvent.click(
    await screen.findByRole("option", {
      name: DECISION_MODEL_CATALOG[provider].label,
    }),
  );
  return provider;
};

test("Advanced has five mode rows with the default decision in the same table", async () => {
  await mount({ ...savedConfig, overrideModels: null });
  fireEvent.click(
    screen.getByRole("button", { name: messages.common.advanced }),
  );
  const row = decisionRow();
  const table = row.parentElement;
  if (table === null) {
    panic("Decision row must belong to the modes table");
  }
  expect(within(table).getAllByRole("group")).toHaveLength(5);
  for (const label of Object.values(messages.organization.aiConfig.roles)) {
    expect(within(table).getByRole("group", { name: label })).toBeDefined();
  }
  expect(row.textContent).toContain(
    messages.organization.aiConfig.usingDefaults,
  );
  expect(row.textContent).toContain(
    messages.organization.aiConfig.decision.generativeFallback,
  );
  expect(
    within(row).getByLabelText(
      messages.organization.aiConfig.modelForRole.replace(
        "{role}",
        () => messages.organization.aiConfig.decision.label,
      ),
    ),
  ).toHaveProperty("disabled", true);
  expect(screen.queryByRole("heading", { name: "Decision model" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Add decision model/u }),
  ).toBeNull();
  fireEvent.click(
    within(row).getByLabelText(
      messages.organization.aiConfig.providerForRole.replace(
        "{role}",
        () => messages.organization.aiConfig.decision.label,
      ),
    ),
  );
  expect(
    screen.getAllByRole("option").map((option) => option.textContent),
  ).toEqual([
    messages.organization.aiConfig.usingDefaults,
    ...DECISION_MODEL_PROVIDERS.map(
      (provider) => DECISION_MODEL_CATALOG[provider].label,
    ),
  ]);
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
});

test("decision changes and reset save the exact decision override", async () => {
  const defaults = { ...savedConfig, overrideModels: null };
  await mount(defaults);
  fireEvent.click(
    screen.getByRole("button", { name: messages.common.advanced }),
  );
  const provider = await selectDecisionProvider();
  const modelId = "fixture-decision-version";
  fireEvent.change(
    within(decisionRow()).getByLabelText(
      messages.organization.aiConfig.modelForRole.replace(
        "{role}",
        () => messages.organization.aiConfig.decision.label,
      ),
    ),
    {
      target: { value: modelId },
    },
  );
  fireEvent.keyDown(
    within(decisionRow()).getByLabelText(
      messages.organization.aiConfig.modelForRole.replace(
        "{role}",
        () => messages.organization.aiConfig.decision.label,
      ),
    ),
    { key: "Escape" },
  );
  fireEvent.change(
    within(decisionRow()).getByLabelText(messages.organization.aiConfig.apiKey),
    {
      target: { value: "fixture-decision-key" },
    },
  );
  expect(within(decisionRow()).getByText(messages.common.custom)).toBeDefined();
  responseConfig = {
    ...defaults,
    decision: { provider, modelId, apiKeyMasked: "****key" },
  };
  fireEvent.click(
    screen.getByRole("button", { name: messages.common.saveChanges }),
  );
  await waitFor(() => expect(hasUnsavedWork()).toBe(false));
  expect(
    JSON.parse(
      requests.find(({ method }) => method === "POST")?.body ?? "null",
    ),
  ).toEqual({
    providers: [{ provider: "google", region: "global" }],
    overrideModels: null,
    decision: { provider, modelId, apiKey: "fixture-decision-key" },
  });
  fireEvent.click(
    within(decisionRow()).getByRole("button", {
      name: messages.common.resetToDefault,
    }),
  );
  expect(within(decisionRow()).queryByText(messages.common.custom)).toBeNull();
  expect(decisionRow().textContent).toContain(
    messages.organization.aiConfig.usingDefaults,
  );
  responseConfig = defaults;
  fireEvent.click(
    screen.getByRole("button", { name: messages.common.saveChanges }),
  );
  await waitFor(() => expect(hasUnsavedWork()).toBe(false));
  expect(
    JSON.parse(
      requests.filter(({ method }) => method === "POST").at(1)?.body ?? "null",
    ),
  ).toEqual({
    providers: [{ provider: "google", region: "global" }],
    overrideModels: null,
    decision: null,
  });
});

test("one page header save writes credential, model and decision changes together", async () => {
  await mount({ ...savedConfig, overrideModels: null });
  const save = screen.getByRole("button", {
    name: messages.common.saveChanges,
  });
  expect(
    screen.getAllByRole("button", { name: messages.common.saveChanges }),
  ).toHaveLength(1);
  expect(save.closest("header")).toBe(
    screen.getByRole("heading", { level: 1 }).closest("header"),
  );
  fireEvent.click(
    screen.getByRole("button", { name: messages.common.advanced }),
  );
  expect(save.closest('[role="region"]')).toBeNull();
  fireEvent.click(
    screen.getByRole("button", {
      name: messages.organization.aiConfig.replaceKey,
    }),
  );
  dirtyKey();
  const chatRow = within(
    screen.getByRole("group", {
      name: messages.organization.aiConfig.roles.chat,
    }),
  );
  const modelId = getModelOptionsForRole({
    provider: "google",
    role: "chat",
  }).find((candidate) => candidate !== BYOK_DEFAULT_MODELS.google.chat.modelId);
  if (modelId === undefined) {
    panic("Google chat must offer an alternate model");
  }
  const chatModel = chatRow.getByLabelText(
    messages.organization.aiConfig.modelForRole.replace(
      "{role}",
      () => messages.organization.aiConfig.roles.chat,
    ),
  );
  act(() => chatModel.focus());
  fireEvent.change(chatModel, { target: { value: modelId } });
  fireEvent.keyDown(chatModel, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: modelId }));
  const provider = await selectDecisionProvider();
  const decisionModelId = DECISION_MODEL_CATALOG[provider].defaultModelId;
  fireEvent.change(
    within(decisionRow()).getByLabelText(messages.organization.aiConfig.apiKey),
    {
      target: { value: "fixture-decision-key" },
    },
  );
  responseConfig = {
    ...savedConfig,
    overrideModels: { chat: { provider: "google", modelId } },
    decision: { provider, modelId: decisionModelId, apiKeyMasked: "****key" },
  };
  expect(save).toHaveProperty("disabled", false);
  fireEvent.click(save);
  await waitFor(() => expect(hasUnsavedWork()).toBe(false));
  const postWrites = requests.filter(({ method }) => method === "POST");
  expect(postWrites).toHaveLength(1);
  expect(JSON.parse(postWrites.at(0)?.body ?? "null")).toEqual({
    providers: [{ provider: "google", apiKey: GOOGLE_KEY, region: "global" }],
    overrideModels: { chat: { provider: "google", modelId } },
    decision: {
      provider,
      modelId: decisionModelId,
      apiKey: "fixture-decision-key",
    },
  });
  expect(
    providerQueries().queryByLabelText(messages.organization.aiConfig.apiKey),
  ).toBeNull();
  expect(document.body.innerHTML).not.toContain(GOOGLE_KEY);
});

test("leaving with an edited decision model prompts before navigation", async () => {
  const appRouter = await mount({ ...savedConfig, overrideModels: null });
  fireEvent.click(
    screen.getByRole("button", { name: messages.common.advanced }),
  );
  await selectDecisionProvider();
  expect(hasUnsavedWork()).toBe(true);
  await act(async () => {
    void appRouter.navigate({ to: "/settings" });
  });
  expect(await screen.findByRole("alertdialog")).toBeDefined();
  expect(appRouter.state.location.pathname).toBe("/settings/organization");
});

test("page header save reveals Anthropic workspace recovery and preserves the complete error", async () => {
  await mount();
  fireEvent.click(
    screen.getByRole("button", {
      name: messages.organization.aiConfig.addProvider,
    }),
  );
  const inputs = providerQueries().getAllByLabelText(
    messages.organization.aiConfig.apiKey,
  );
  const google = inputs.at(0);
  const anthropic = inputs.at(1);
  if (google === undefined || anthropic === undefined) {
    panic("Both credential drafts must be present");
  }
  fireEvent.change(google, { target: { value: GOOGLE_KEY } });
  const key = `sk-ant-api03-${"b".repeat(32)}5678`;
  fireEvent.change(anthropic, { target: { value: key } });
  expect(
    screen.queryByLabelText(
      messages.organization.aiConfig.anthropicWorkspaceId,
    ),
  ).toBeNull();
  const reason = `Anthropic requires a workspace. ${"Provider setup details. ".repeat(30)}Final workspace recovery instruction.`;
  settingsFailure = {
    code: "ai_config_anthropic_workspace_required",
    message: reason,
  };
  fireEvent.click(
    screen.getByRole("button", { name: messages.common.saveChanges }),
  );
  const error = await screen.findByRole("alert");
  expect(error.textContent).toContain(reason);
  expect(error.textContent).toContain(
    messages.organization.aiConfig.anthropicWorkspaceRequired,
  );
  expect(
    screen.getByRole("link", {
      name: messages.organization.aiConfig.anthropicWorkspaces,
    }),
  ).toHaveProperty("href", "https://console.anthropic.com/settings/workspaces");
  const workspace = screen.getByLabelText(
    messages.organization.aiConfig.anthropicWorkspaceId,
  );
  expect(anthropic).toHaveProperty("value", key);
  expect(hasUnsavedWork()).toBe(true);
  fireEvent.change(workspace, { target: { value: "wrk_fixture" } });
  settingsFailure = undefined;
  responseConfig = {
    ...savedConfig,
    overrideModels: null,
    providers: [
      ...savedConfig.providers,
      {
        provider: "anthropic",
        apiKeyMasked: "sk-ant-api03****5678",
        region: "global",
        anthropicWorkspaceId: "wrk_fixture",
      },
    ],
  };
  fireEvent.click(
    screen.getByRole("button", { name: messages.common.saveChanges }),
  );
  await waitFor(() => expect(hasUnsavedWork()).toBe(false));
  const postWrites = requests.filter(({ method }) => method === "POST");
  expect(postWrites).toHaveLength(2);
  expect(JSON.parse(postWrites.at(1)?.body ?? "null")).toEqual({
    providers: [
      { provider: "google", apiKey: GOOGLE_KEY, region: "global" },
      {
        provider: "anthropic",
        apiKey: key,
        region: "global",
        anthropicWorkspaceId: "wrk_fixture",
      },
    ],
    overrideModels: null,
  });
  expect(screen.queryByRole("alert")).toBeNull();
});

test("decision model picker offers its provider default and accepts an arbitrary model ID", async () => {
  await mount({ ...savedConfig, overrideModels: null });
  fireEvent.click(
    screen.getByRole("button", { name: messages.common.advanced }),
  );
  const provider = await selectDecisionProvider();
  const model = within(decisionRow()).getByLabelText(
    messages.organization.aiConfig.modelForRole.replace(
      "{role}",
      () => messages.organization.aiConfig.decision.label,
    ),
  );
  act(() => model.focus());
  fireEvent.keyDown(model, { key: "ArrowDown" });
  expect(
    await screen.findByRole("option", {
      name: DECISION_MODEL_CATALOG[provider].defaultModelId,
    }),
  ).toBeDefined();
  expect(
    screen.getAllByRole("option").map((option) => option.textContent),
  ).toEqual([DECISION_MODEL_CATALOG[provider].defaultModelId]);
  const modelId = "fixture-provider-model-version";
  fireEvent.change(model, { target: { value: modelId } });
  expect(await screen.findByRole("option", { name: modelId })).toBeDefined();
  expect(
    screen.getAllByRole("option").map((option) => option.textContent),
  ).toEqual([modelId]);
  fireEvent.click(screen.getByRole("option", { name: modelId }));
  expect(model).toHaveProperty("value", modelId);
});

test("one page Save commits both provider drafts and all auxiliary sections", async () => {
  await mount();
  await deeplQueries().findByLabelText(messages.translate.settings.apiKeyLabel);
  dirtyKey();
  fireEvent.click(
    screen.getByRole("button", {
      name: messages.organization.aiConfig.addProvider,
    }),
  );
  const anthropic = providerQueries()
    .getAllByLabelText(messages.organization.aiConfig.apiKey)
    .at(1);
  if (anthropic === undefined) {
    panic("Anthropic draft must be present");
  }
  const anthropicKey = `sk-ant-api03-${"b".repeat(32)}5678`;
  fireEvent.change(anthropic, { target: { value: anthropicKey } });
  fireEvent.change(
    deeplQueries().getByLabelText(messages.translate.settings.apiKeyLabel),
    { target: { value: "fixture-deepl-key" } },
  );
  const search = document.querySelector("#web-search-key-search");
  const fetch = document.querySelector("#web-search-key-fetch");
  if (search === null || fetch === null) {
    panic("Both web search key fields must be present");
  }
  fireEvent.change(search, { target: { value: "fixture-search-key" } });
  fireEvent.change(fetch, { target: { value: "fixture-reader-key" } });
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: messages.settings.organization.promptCaching.toggleLabel,
    }),
  );
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: messages.settings.organization.documentProcessing.toggleLabel,
    }),
  );
  const memory = screen.queryByRole("checkbox", {
    name: messages.settings.organization.memoryExtraction.toggleLabel,
  });
  if (memory !== null) {
    fireEvent.click(memory);
  }
  expect(writes()).toEqual([]);
  expect(
    screen.queryByRole("button", { name: messages.common.save }),
  ).toBeNull();
  expect(
    screen.getAllByRole("button", { name: messages.common.saveChanges }),
  ).toHaveLength(1);
  responseConfig = {
    ...savedConfig,
    overrideModels: null,
    providers: [
      ...savedConfig.providers,
      {
        provider: "anthropic",
        apiKeyMasked: "sk-ant-api03****5678",
        region: "global",
      },
    ],
  };
  savePage();
  await waitFor(() => expect(hasUnsavedWork()).toBe(false));
  expect(writes()).toHaveLength(memory === null ? 6 : 7);
  expect(
    JSON.parse(
      writes().find(({ url }) => url.includes("ai-config"))?.body ?? "null",
    ),
  ).toEqual({
    providers: [
      { provider: "google", apiKey: GOOGLE_KEY, region: "global" },
      { provider: "anthropic", apiKey: anthropicKey, region: "global" },
    ],
    overrideModels: null,
  });
  expect(
    JSON.parse(
      writes().find(({ url }) => url.endsWith("/deepl"))?.body ?? "null",
    ),
  ).toEqual({ apiKey: "fixture-deepl-key" });
  expect(
    writes()
      .filter(({ url }) => url.endsWith("/web-search-key"))
      .map(({ body }) => JSON.parse(body)),
  ).toEqual([
    { kind: "search", apiKey: "fixture-search-key" },
    { kind: "fetch", apiKey: "fixture-reader-key" },
  ]);
  expect(
    writes()
      .filter(({ url }) => url.endsWith("/organization-settings"))
      .map(({ body }) => JSON.parse(body)),
  ).toEqual([
    { promptCachingEnabled: true },
    { documentProcessingMode: "searchable-text" },
    ...(memory === null ? [] : [{ memoryExtractionEnabled: true }]),
  ]);
  expect(
    deeplQueries().getByLabelText(messages.translate.settings.apiKeyLabel),
  ).toHaveProperty("value", "");
  expect(search).toHaveProperty("value", "");
  expect(fetch).toHaveProperty("value", "");
  const savedSections = [
    messages.translate.settings.title,
    messages.webSearch.settings.searchTitle,
    messages.webSearch.settings.fetchTitle,
    messages.settings.organization.promptCaching.title,
    messages.settings.organization.documentProcessing.title,
    ...(memory === null
      ? []
      : [messages.settings.organization.memoryExtraction.title]),
  ];
  for (const title of savedSections) {
    expect(settingsSectionQueries(title).getByRole("status").textContent).toBe(
      messages.common.saved,
    );
    expect(settingsSectionQueries(title).queryByRole("alert")).toBeNull();
  }
});

test("a failed auxiliary section retains its draft while successful sections clear and retry only sends the failed section", async () => {
  const appRouter = await mount(savedConfig);
  const deepl = await deeplQueries().findByLabelText(
    messages.translate.settings.apiKeyLabel,
  );
  const search = document.querySelector("#web-search-key-search");
  if (search === null) {
    panic("Search field must be present");
  }
  fireEvent.change(deepl, { target: { value: "fixture-deepl-key" } });
  fireEvent.change(search, { target: { value: "fixture-search-key" } });
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: messages.settings.organization.promptCaching.toggleLabel,
    }),
  );
  auxiliaryFailure = {
    path: "/deepl",
    message: "DeepL setup needs correction",
  };
  expect(writes()).toEqual([]);
  savePage();
  expect((await screen.findByRole("alert")).textContent).toContain(
    auxiliaryFailure.message,
  );
  await waitFor(() => expect(search).toHaveProperty("value", ""));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: messages.common.saveChanges }),
    ).toHaveProperty("disabled", false),
  );
  expect(deepl).toHaveProperty("value", "fixture-deepl-key");
  const failedSection = settingsSectionQueries(
    messages.translate.settings.title,
  );
  expect(failedSection.getByRole("alert").textContent).toContain(
    auxiliaryFailure.message,
  );
  expect(failedSection.queryByRole("status")).toBeNull();
  for (const title of [
    messages.webSearch.settings.searchTitle,
    messages.settings.organization.promptCaching.title,
  ]) {
    expect(settingsSectionQueries(title).getByRole("status").textContent).toBe(
      messages.common.saved,
    );
    expect(settingsSectionQueries(title).queryByRole("alert")).toBeNull();
  }
  expect(hasUnsavedWork()).toBe(true);
  expect(writes()).toHaveLength(3);
  await act(async () => {
    void appRouter.navigate({ to: "/settings" });
  });
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(
    screen.getByRole("button", { name: messages.common.goBackToEditing }),
  );
  await waitFor(() =>
    expect(Object.hasOwn(dialog.dataset, "open")).toBe(false),
  );
  auxiliaryFailure = undefined;
  savePage();
  await waitFor(() => expect(hasUnsavedWork()).toBe(false));
  expect(writes()).toHaveLength(4);
  expect(writes().at(-1)?.url).toMatch(/\/deepl$/u);
  expect(JSON.parse(writes().at(-1)?.body ?? "null")).toEqual({
    apiKey: "fixture-deepl-key",
  });
  expect(deepl).toHaveProperty("value", "");
  expect(
    settingsSectionQueries(messages.translate.settings.title).getByRole(
      "status",
    ).textContent,
  ).toBe(messages.common.saved);
  expect(screen.queryByRole("alert")).toBeNull();
});

const DIRTY_ONLY_SECTIONS = {
  deepl: "deepl",
  promptCaching: "promptCaching",
} as const;

test.each(Object.values(DIRTY_ONLY_SECTIONS))(
  "leaving with only a dirty %s section prompts and sends no writes",
  async (section) => {
    const appRouter = await mount(savedConfig);
    const deepl = await deeplQueries().findByLabelText(
      messages.translate.settings.apiKeyLabel,
    );
    if (section === "deepl") {
      fireEvent.change(deepl, { target: { value: "fixture-deepl-key" } });
    } else {
      fireEvent.click(
        screen.getByRole("checkbox", {
          name: messages.settings.organization.promptCaching.toggleLabel,
        }),
      );
    }
    expect(hasUnsavedWork()).toBe(true);
    expect(writes()).toEqual([]);
    await act(async () => {
      void appRouter.navigate({ to: "/settings" });
    });
    expect(await screen.findByRole("alertdialog")).toBeDefined();
    expect(appRouter.state.location.pathname).toBe("/settings/organization");
  },
);

test("provider removal is staged until Save and preserves remaining credentials", async () => {
  await mount({
    ...savedConfig,
    overrideModels: null,
    providers: [
      ...savedConfig.providers,
      {
        provider: "openrouter",
        apiKeyMasked: "sk-or-v1****5678",
        region: "global",
      },
    ],
  });
  const remove = screen
    .getAllByRole("button", {
      name: messages.organization.aiConfig.removeProvider,
    })
    .at(1);
  if (remove === undefined) {
    panic("Second provider removal must be present");
  }
  fireEvent.click(remove);
  fireEvent.click(
    await screen.findByRole("button", { name: messages.common.confirm }),
  );
  await waitFor(() =>
    expect(screen.queryByText("sk-or-v1****5678")).toBeNull(),
  );
  expect(writes()).toEqual([]);
  expect(hasUnsavedWork()).toBe(true);
  responseConfig = { ...savedConfig, overrideModels: null };
  savePage();
  await waitFor(() => expect(hasUnsavedWork()).toBe(false));
  expect(writes()).toHaveLength(1);
  expect(JSON.parse(writes().at(0)?.body ?? "null")).toEqual({
    providers: [{ provider: "google", region: "global" }],
    overrideModels: null,
  });
});

test("removing the last provider stages a delete and keeps the leave prompt until Save", async () => {
  await mount(savedConfig);
  fireEvent.click(
    screen.getByRole("button", {
      name: new RegExp(messages.common.advanced, "u"),
    }),
  );
  fireEvent.click(
    within(
      screen.getByRole("group", {
        name: messages.organization.aiConfig.roles.chat,
      }),
    ).getByRole("button", { name: messages.common.resetToDefault }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: messages.organization.aiConfig.removeProvider,
    }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: messages.common.confirm }),
  );
  await waitFor(() => expect(screen.queryByText("AIza****1234")).toBeNull());
  expect(writes()).toEqual([]);
  expect(hasUnsavedWork()).toBe(true);
  savePage();
  await waitFor(() => expect(hasUnsavedWork()).toBe(false));
  expect(writes()).toHaveLength(1);
  expect(writes().at(0)?.method).toBe("DELETE");
  expect(
    screen.queryByRole("button", {
      name: messages.organization.aiConfig.removeProvider,
    }),
  ).toBeNull();
});

test("page Save refuses writes after the session organization changes and retains every draft", async () => {
  await mount();
  const deepl = await deeplQueries().findByLabelText(
    messages.translate.settings.apiKeyLabel,
  );
  dirtyKey();
  fireEvent.change(deepl, { target: { value: "fixture-deepl-key" } });
  sessionOrganization = "another-organization";
  savePage();
  await screen.findAllByRole("alert");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: messages.common.saveChanges }),
    ).toHaveProperty("disabled", false),
  );
  expect(writes()).toEqual([]);
  expect(deepl).toHaveProperty("value", "fixture-deepl-key");
  expect(
    providerQueries().getByLabelText(messages.organization.aiConfig.apiKey),
  ).toHaveProperty("value", GOOGLE_KEY);
  expect(hasUnsavedWork()).toBe(true);
});

test.each([false, true])(
  "unreadable AI removal is staged with auxiliary drafts and failed delete stays dirty (delete fails: %s)",
  async (deleteFails) => {
    await mount(config, { status: "unreadable", onRetry: () => undefined });
    const deepl = deeplQueries().getByLabelText(
      messages.translate.settings.apiKeyLabel,
    );
    fireEvent.change(deepl, { target: { value: "fixture-deepl-key" } });
    fireEvent.click(
      screen.getByRole("button", { name: messages.common.remove }),
    );
    expect(
      screen.getByRole("button", { name: messages.common.cancel }),
    ).toBeDefined();
    expect(writes()).toEqual([]);
    expect(hasUnsavedWork()).toBe(true);
    if (deleteFails) {
      settingsFailure = {
        code: "ai_config_remove_failed",
        message: "Configuration removal needs correction",
      };
    }
    savePage();
    await waitFor(() => expect(deepl).toHaveProperty("value", ""));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: messages.common.saveChanges }),
      ).toHaveProperty("disabled", !deleteFails),
    );
    expect(writes()).toHaveLength(2);
    const removal = writes().find(({ url }) => url.includes("ai-config"));
    expect(removal?.method).toBe("DELETE");
    expect(
      JSON.parse(
        writes().find(({ url }) => url.endsWith("/deepl"))?.body ?? "null",
      ),
    ).toEqual({ apiKey: "fixture-deepl-key" });
    expect(hasUnsavedWork()).toBe(deleteFails);
    if (deleteFails) {
      expect((await screen.findByRole("alert")).textContent).toContain(
        "Configuration removal needs correction",
      );
      expect(
        screen.getByRole("button", { name: messages.common.cancel }),
      ).toBeDefined();
      settingsFailure = undefined;
      savePage();
      await waitFor(() => expect(hasUnsavedWork()).toBe(false));
      expect(writes()).toHaveLength(3);
      expect(writes().at(-1)?.method).toBe("DELETE");
      expect(writes().at(-1)?.url).toContain("ai-config");
    }
  },
);

test("recovering readable AI settings cancels pending removal and preserves auxiliary edits", async () => {
  const provider = DECISION_MODEL_PROVIDERS.at(0);
  if (provider === undefined) {
    panic("Decision provider must be present");
  }
  const recovered = {
    ...savedConfig,
    decision: {
      provider,
      modelId: "fixture-recovered-decision",
      apiKeyMasked: "****decision",
    },
  } satisfies OrganizationAIConfig;
  await mount(recovered, { status: "unreadable", onRetry: () => undefined });
  const deepl = deeplQueries().getByLabelText(
    messages.translate.settings.apiKeyLabel,
  );
  fireEvent.change(deepl, { target: { value: "fixture-deepl-key" } });
  fireEvent.click(screen.getByRole("button", { name: messages.common.remove }));
  expect(
    screen.getByRole("button", { name: messages.common.cancel }),
  ).toBeDefined();
  expect(writes()).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: messages.common.retry }));
  expect(await screen.findByText("AIza****1234")).toBeDefined();
  fireEvent.click(
    screen.getByRole("button", {
      name: new RegExp(messages.common.advanced, "u"),
    }),
  );
  expect(
    within(decisionRow()).getByLabelText(
      messages.organization.aiConfig.modelForRole.replace(
        "{role}",
        () => messages.organization.aiConfig.decision.label,
      ),
    ),
  ).toHaveProperty("value", recovered.decision.modelId);
  expect(
    within(decisionRow()).getByLabelText(messages.organization.aiConfig.apiKey),
  ).toHaveProperty(
    "placeholder",
    messages.organization.aiConfig.apiKeyConfiguredPlaceholder.replace(
      "{key}",
      () => recovered.decision.apiKeyMasked,
    ),
  );
  expect(deepl).toHaveProperty("value", "fixture-deepl-key");
  expect(
    screen.queryByRole("button", { name: messages.common.cancel }),
  ).toBeNull();
  expect(hasUnsavedWork()).toBe(true);
  expect(writes()).toEqual([]);
  savePage();
  await waitFor(() => expect(hasUnsavedWork()).toBe(false));
  expect(writes()).toHaveLength(1);
  expect(writes().at(0)?.method).toBe("POST");
  expect(writes().at(0)?.url).toMatch(/\/deepl$/u);
  expect(JSON.parse(writes().at(0)?.body ?? "null")).toEqual({
    apiKey: "fixture-deepl-key",
  });
});
