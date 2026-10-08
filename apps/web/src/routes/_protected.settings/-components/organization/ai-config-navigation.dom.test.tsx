import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import { BYOK_DEFAULT_MODELS } from "@stll/ai-catalog";
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
  settingsFailure = undefined;
  reflectProviderOrder = false;
  responseConfig = savedConfig;
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  cleanup();
  await act(async () => await sleep(50));
  await GlobalRegistrator.unregister();
});

const mount = async (initialConfig: OrganizationAIConfig = config) => {
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
  fireEvent.click(screen.getByRole("button", { name: messages.common.save }));
  await screen.findByText(messages.organization.aiConfig.savedVerified);
  expect(screen.getByText("AIza****1234")).toBeDefined();
  expect(
    screen.queryByLabelText(messages.organization.aiConfig.apiKey),
  ).toBeNull();
  expect(document.body.innerHTML).not.toContain(GOOGLE_KEY);
  const writes = requests.filter(
    ({ method }) => method === "POST" || method === "DELETE",
  );
  expect(writes).toHaveLength(1);
  expect(writes.at(0)?.method).toBe("POST");
  expect(writes.at(0)?.body).toContain(
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
    screen.getByLabelText(messages.organization.aiConfig.apiKey),
  ).toHaveProperty("value", GOOGLE_KEY);
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
  const removeButton = removeButtons.at(1);
  if (removeButton === undefined) {
    panic("The second provider must have a remove control");
  }
  fireEvent.click(removeButton);
  expect(
    requests.filter(
      (request) => request.method === "POST" || request.method === "DELETE",
    ),
  ).toEqual([]);
  fireEvent.click(
    await screen.findByRole("button", { name: messages.common.confirm }),
  );
  await waitFor(() =>
    expect(screen.queryByText("sk-or-v1****5678") === null).toBe(true),
  );
  expect(screen.getByText("AIza****1234")).toBeDefined();
  const writes = requests.filter(
    (request) => request.method === "POST" || request.method === "DELETE",
  );
  expect(writes).toHaveLength(1);
  expect(writes.at(0)?.method).toBe("POST");
  const body = writes.at(0)?.body;
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
  expect((await screen.findByRole("alertdialog")).textContent).toContain(
    messages.organization.aiConfig.removeLastProviderConfirm.replace(
      "{provider}",
      "Google",
    ),
  );
  fireEvent.click(
    screen.getByRole("button", { name: messages.common.confirm }),
  );
  await waitFor(() =>
    expect(screen.queryByText("AIza****1234") === null).toBe(true),
  );
  const writes = requests.filter(
    (request) => request.method === "POST" || request.method === "DELETE",
  );
  expect(writes).toHaveLength(1);
  expect(writes.at(0)?.method).toBe("DELETE");
  expect(
    screen.queryByRole("button", {
      name: messages.organization.aiConfig.removeProvider,
    }),
  ).toBeNull();
  expect(hasUnsavedWork()).toBe(false);
});

test("removing the last provider clears edited roles and the leave prompt", async () => {
  await mount(savedConfig);
  fireEvent.click(
    screen.getByRole("button", {
      name: new RegExp(messages.common.advanced, "u"),
    }),
  );
  const modelLabel = messages.organization.aiConfig.modelForRole.replace(
    "{role}",
    () => messages.organization.aiConfig.roles.chat,
  );
  const model = screen.getByLabelText(modelLabel);
  fireEvent.change(model, { target: { value: "" } });
  fireEvent.keyDown(model, { key: "Escape" });
  fireEvent.blur(model);
  expect(hasUnsavedWork()).toBe(true);
  fireEvent.click(
    screen.getByRole("button", {
      name: messages.organization.aiConfig.removeProvider,
    }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: messages.common.confirm }),
  );
  await waitFor(() => expect(screen.queryByText("AIza****1234")).toBeNull());
  expect(screen.queryByLabelText(modelLabel)).toBeNull();
  expect(hasUnsavedWork()).toBe(false);
  const writes = requests.filter(
    ({ method }) => method === "POST" || method === "DELETE",
  );
  expect(writes).toHaveLength(1);
  expect(writes.at(0)?.method).toBe("DELETE");
});

test("saving one dirty row preserves the other key and its leave prompt", async () => {
  const appRouter = await mount();
  fireEvent.click(
    screen.getByRole("button", {
      name: messages.organization.aiConfig.addProvider,
    }),
  );
  const inputs = screen.getAllByLabelText(
    messages.organization.aiConfig.apiKey,
  );
  expect(inputs).toHaveLength(2);
  const otherKey = `sk-ant-api03-${"b".repeat(32)}5678`;
  const googleInput = inputs.at(0);
  const anthropicInput = inputs.at(1);
  if (googleInput === undefined || anthropicInput === undefined) {
    panic("Both provider key inputs must be present");
  }
  fireEvent.change(googleInput, { target: { value: GOOGLE_KEY } });
  fireEvent.change(anthropicInput, { target: { value: otherKey } });
  const saveButtons = screen.getAllByRole("button", {
    name: messages.common.save,
  });
  expect(saveButtons).toHaveLength(2);
  const saveButton = saveButtons.at(0);
  if (saveButton === undefined) {
    panic("The Google provider must have a save control");
  }
  fireEvent.click(saveButton);
  await screen.findByText(messages.organization.aiConfig.savedVerified);
  expect(screen.getByText("AIza****1234")).toBeDefined();
  expect(
    screen.getByLabelText(messages.organization.aiConfig.apiKey),
  ).toHaveProperty("value", otherKey);
  expect(screen.getByText(messages.common.unsavedChanges)).toBeDefined();
  expect(hasUnsavedWork()).toBe(true);
  const writes = requests.filter(
    ({ method }) => method === "POST" || method === "DELETE",
  );
  expect(writes).toHaveLength(1);
  expect(writes.at(0)?.body).toContain(
    `"providers":${JSON.stringify([{ provider: "google", apiKey: GOOGLE_KEY, region: "global" }])}`,
  );
  expect(writes.at(0)?.body).not.toContain(otherKey);
  expect(writes.at(0)?.body).not.toContain('"provider":"anthropic"');
  await act(async () => {
    void appRouter.navigate({ to: "/settings" });
  });
  expect(await screen.findByRole("alertdialog")).toBeDefined();
  expect(appRouter.state.location.pathname).toBe("/settings/organization");
});

test("card save preserves the full Eden provider error and Workspace ID guidance", async () => {
  await mount();
  fireEvent.click(
    screen.getByRole("button", {
      name: messages.organization.aiConfig.addProvider,
    }),
  );
  const input = screen
    .getAllByLabelText(messages.organization.aiConfig.apiKey)
    .at(1);
  const save = screen
    .getAllByRole("button", { name: messages.common.save })
    .at(1);
  if (input === undefined || save === undefined) {
    panic("Anthropic row must be present");
  }
  const key = `sk-ant-api03-${"b".repeat(32)}5678`;
  const reason = `Anthropic: This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. ${"Provider setup details. ".repeat(30)}Final workspace recovery instruction.`;
  settingsFailure = {
    code: "ai_config_anthropic_workspace_required",
    message: reason,
  };
  fireEvent.change(input, { target: { value: key } });
  expect(
    screen.queryByLabelText(
      messages.organization.aiConfig.anthropicWorkspaceId,
    ),
  ).toBeNull();
  fireEvent.click(save);
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
  expect(
    screen.getByLabelText(messages.organization.aiConfig.anthropicWorkspaceId),
  ).toBeDefined();
  expect(input).toHaveProperty("value", key);
  expect(
    screen.queryByText(messages.organization.aiConfig.savedVerified),
  ).toBeNull();
  const writes = requests.filter(
    ({ method }) => method === "POST" || method === "DELETE",
  );
  expect(writes).toHaveLength(1);
  expect(writes.at(0)?.body).toContain('"provider":"anthropic"');
});

test("card removal preserves the full Eden provider error in the saved row", async () => {
  await mount(savedConfig);
  const reason = `Google: Configuration removal was refused. ${"Full provider details. ".repeat(30)}Final removal instruction.`;
  settingsFailure = { code: "ai_config_invalid", message: reason };
  fireEvent.click(
    screen.getByRole("button", {
      name: messages.organization.aiConfig.removeProvider,
    }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: messages.common.confirm }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(reason);
  expect(screen.getByText("AIza****1234")).toBeDefined();
  const writes = requests.filter(
    ({ method }) => method === "POST" || method === "DELETE",
  );
  expect(writes).toHaveLength(1);
  expect(writes.at(0)?.method).toBe("DELETE");
});

test("clearing a draft workspace ID back to absent clears row dirty state and the leave prompt", async () => {
  const appRouter = await mount();
  fireEvent.click(
    screen.getByRole("button", {
      name: messages.organization.aiConfig.addProvider,
    }),
  );
  const input = screen
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
    screen.getAllByText(messages.organization.aiConfig.usingDefaults),
  ).toHaveLength(4);
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

test("saving a key in the compact view sends no role overrides", async () => {
  responseConfig = { ...savedConfig, overrideModels: null };
  await mount();
  dirtyKey();
  fireEvent.click(screen.getByRole("button", { name: messages.common.save }));
  await screen.findByText(messages.organization.aiConfig.savedVerified);
  expect(requests.find(({ method }) => method === "POST")?.body).not.toContain(
    "overrideModels",
  );
  expect(
    screen.queryByText(messages.organization.aiConfig.modelsPanel),
  ).toBeNull();
  expect(screen.queryByText(messages.common.custom)).toBeNull();
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
  fireEvent.click(screen.getByRole("button", { name: messages.common.save }));
  await screen.findByText(messages.organization.aiConfig.savedVerified);
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
  expect(write?.body).not.toContain("overrideModels");
  expect(hasUnsavedWork()).toBe(false);
});
