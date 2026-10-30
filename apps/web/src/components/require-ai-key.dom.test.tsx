import type { PropsWithChildren, ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import {
  AI_PROVIDER_CONFIGURATION,
  AI_UNAVAILABLE_REASON,
} from "@stll/api-contract/organization-ai-availability";
import type { OrganizationAIAvailability } from "@stll/api-contract/organization-ai-availability";
import { isOrganizationManagementRole, roles } from "@stll/permissions";

import {
  aiAvailableResponse,
  aiUnavailableResponse,
} from "@/__fixtures__/ai-availability";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law/cz/cases/1" });

const originalFetch = globalThis.fetch;
let configStatus = 200;
let availabilityStatus = 200;
let availabilityHold: Promise<void> | null = null;
let instanceProvisioned = false;
let unavailableReason: NonNullable<
  OrganizationAIAvailability["unavailableReason"]
> = "provider_not_configured";
let providerConfiguration: OrganizationAIAvailability["providerConfiguration"] =
  "allowed";
let aiConfigRequests = 0;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.startsWith("/api/auth/")) {
      return Response.json(null);
    }
    if (url.pathname.endsWith("/organization-settings/ai-availability")) {
      if (availabilityHold !== null) {
        await availabilityHold;
      }
      if (availabilityStatus !== 200) {
        return Response.json(
          { error: "Unavailable" },
          { status: availabilityStatus },
        );
      }
      if (unavailableReason === "unreadable") {
        return Response.json(
          aiUnavailableResponse({
            providerConfiguration,
            unavailableReason: "unreadable",
          }),
        );
      }
      if (instanceProvisioned) {
        return Response.json({
          ...aiAvailableResponse(),
          providerConfiguration,
        });
      }
      return Response.json(
        aiUnavailableResponse({ providerConfiguration, unavailableReason }),
      );
    }
    if (
      url.pathname.endsWith("/organization-settings/ai-config/defaults-preview")
    ) {
      return Response.json({
        defaultModels: {
          chat: { provider: "google", modelId: "gemini-3.8-flash" },
          fast: { provider: "google", modelId: "gemini-3.8-flash" },
          reasoning: { provider: "google", modelId: "gemini-3.8-flash" },
          pdf: { provider: "google", modelId: "gemini-3.8-flash" },
        },
        providerDefaultModels: [
          {
            provider: "google",
            defaultModels: {
              chat: { provider: "google", modelId: "gemini-3.8-flash" },
              fast: { provider: "google", modelId: "gemini-3.8-flash" },
              reasoning: { provider: "google", modelId: "gemini-3.8-flash" },
              pdf: { provider: "google", modelId: "gemini-3.8-flash" },
            },
          },
        ],
      });
    }
    if (url.pathname.endsWith("/organization-settings/ai-config")) {
      aiConfigRequests += 1;
      return configStatus === 200
        ? Response.json({
            configured: false,
            instanceProvisioned: false,
            decisionInstanceProvisioned: false,
            providerDefaultModels: [],
            defaultModels: {
              chat: null,
              fast: null,
              reasoning: null,
              pdf: null,
            },
          })
        : Response.json({ error: "Forbidden" }, { status: configStatus });
    }
    return Response.json({});
  },
  { preconnect: originalFetch.preconnect },
);

const { act, cleanup, render, screen, waitFor, fireEvent } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { default: messages } = await import("@/i18n/langs/en.json");
const { stellaToast } = await import("@stll/ui/toast");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const {
  AIAvailabilityProvider,
  AIUnavailableDialogTrigger,
  RequireAIKey,
  useAIKeyGate,
} = await import("./require-ai-key");

afterEach(() => {
  cleanup();
  providerConfiguration = "allowed";
  availabilityStatus = 200;
  availabilityHold = null;
  instanceProvisioned = false;
  unavailableReason = "provider_not_configured";
  aiConfigRequests = 0;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const settle = async () => {
  for (let tick = 0; tick < 5; tick += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

test.each([
  [200, "cancel"],
  [403, "cancel"],
  [200, "escape"],
  [403, "escape"],
  [500, "cancel"],
] as const)(
  "an explicitly opened AI key dialog stays closed after dismissal (config read %d, %s)",
  async (status, dismissal) => {
    configStatus = status;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthenticatedUserProvider
          user={{
            activeOrganizationId: "org-1",
            email: "member@example.test",
            id: "user-1",
            image: null,
            name: "Member",
            preferredName: null,
            timezoneId: "UTC",
            wordEditShortcut: null,
          }}
        >
          <IntlProvider locale="en" messages={messages} timeZone="UTC">
            <FormattingProvider locale="en" timeZone="UTC">
              <AIAvailabilityProvider>
                <AIUnavailableDialogTrigger />
              </AIAvailabilityProvider>
            </FormattingProvider>
          </IntlProvider>
        </AuthenticatedUserProvider>
      </QueryClientProvider>,
    );
    const isOpen = () => {
      const popup = screen
        .queryByRole("heading", { name: "Connect AI provider", hidden: true })
        ?.closest('[role="dialog"]');
      return (
        popup instanceof HTMLElement && popup.dataset["open"] !== undefined
      );
    };
    expect(isOpen()).toBe(false);
    fireEvent.click(
      await screen.findByRole("button", { name: messages.ai.keyRequired.cta }),
    );
    const heading = await screen.findByRole("heading", {
      name: "Connect AI provider",
    });
    expect(heading).toBeDefined();
    expect(isOpen()).toBe(true);
    await settle();
    if (status === 403) {
      expect(
        screen.getByText(
          "Only an organization admin can connect an AI provider.",
        ),
      ).toBeDefined();
      expect(screen.getByRole("button", { name: "Configure" }).title).toBe(
        "Only an organization admin can connect an AI provider.",
      );
    }
    if (status === 500) {
      // A failure that is not a refusal keeps the retry feedback.
      expect(
        screen.getByText(
          "Something went wrong. Try again, or reload the page if it keeps happening.",
        ),
      ).toBeDefined();
      expect(
        screen.queryByText(
          "Only an organization admin can connect an AI provider.",
        ),
      ).toBeNull();
    }
    if (dismissal === "cancel") {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    } else {
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: "Escape",
      });
    }
    await waitFor(() => {
      expect(isOpen()).toBe(false);
    });
    await settle();
    expect(isOpen()).toBe(false);
    queryClient.clear();
  },
);

test.each([
  [
    "permission_required",
    "Only an organization admin can connect an AI provider.",
  ],
  [
    "account_restricted",
    "AI provider settings are unavailable for this account.",
  ],
] as const)(
  "%s capability never renders settings guidance or reads AI config",
  async (capability, message) => {
    providerConfiguration = capability;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthenticatedUserProvider
          user={{
            activeOrganizationId: "org-1",
            email: "member@example.test",
            id: "user-1",
            image: null,
            name: "Member",
            preferredName: null,
            timezoneId: "UTC",
            wordEditShortcut: null,
          }}
        >
          <IntlProvider locale="en" messages={messages} timeZone="UTC">
            <FormattingProvider locale="en" timeZone="UTC">
              <AIAvailabilityProvider>
                <AIUnavailableDialogTrigger />
              </AIAvailabilityProvider>
            </FormattingProvider>
          </IntlProvider>
        </AuthenticatedUserProvider>
      </QueryClientProvider>,
    );

    await settle();
    expect(screen.queryByText(message)).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Connect AI provider" }),
    ).toBeNull();
    expect(aiConfigRequests).toBe(0);
    queryClient.clear();
  },
);

test("an AI action a member cannot unblock says why instead of doing nothing", async () => {
  providerConfiguration = "permission_required";
  const toast = spyOn(stellaToast, "add").mockReturnValue("toast-1");
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const gates = new Map<"gate", ReturnType<typeof useAIKeyGate>>();
  const CaptureGate = () => {
    gates.set("gate", useAIKeyGate());
    return null;
  };
  try {
    render(
      <QueryClientProvider client={queryClient}>
        <AuthenticatedUserProvider
          user={{
            activeOrganizationId: "org-1",
            email: "member@example.test",
            id: "user-1",
            image: null,
            name: "Member",
            preferredName: null,
            timezoneId: "UTC",
            wordEditShortcut: null,
          }}
        >
          <IntlProvider locale="en" messages={messages} timeZone="UTC">
            <FormattingProvider locale="en" timeZone="UTC">
              <AIAvailabilityProvider>
                <CaptureGate />
              </AIAvailabilityProvider>
            </FormattingProvider>
          </IntlProvider>
        </AuthenticatedUserProvider>
      </QueryClientProvider>,
    );
    await settle();
    let proceeded: boolean | undefined;
    await act(async () => {
      proceeded = await gates.get("gate")?.ensureAIAvailable();
    });
    expect(proceeded).toBe(false);
    expect(toast).toHaveBeenCalledWith({
      title: messages.ai.keyRequired.description,
      type: "info",
    });
    expect(
      screen.queryByRole("heading", { name: "Connect AI provider" }),
    ).toBeNull();
    expect(aiConfigRequests).toBe(0);
  } finally {
    toast.mockRestore();
    queryClient.clear();
  }
});

test("a provider under another provider reuses the outer gate", async () => {
  configStatus = 200;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // The gate's value changes as the availability read resolves, so only the
  // latest value each surface saw is compared.
  const gates = new Map<"inner" | "outer", unknown>();
  const CaptureGate = ({ at }: { at: "inner" | "outer" }) => {
    gates.set(at, useAIKeyGate());
    return null;
  };
  render(
    <QueryClientProvider client={queryClient}>
      <AuthenticatedUserProvider
        user={{
          activeOrganizationId: "org-1",
          email: "member@example.test",
          id: "user-1",
          image: null,
          name: "Member",
          preferredName: null,
          timezoneId: "UTC",
          wordEditShortcut: null,
        }}
      >
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <FormattingProvider locale="en" timeZone="UTC">
            <AIAvailabilityProvider>
              <CaptureGate at="outer" />
              <AIAvailabilityProvider>
                <CaptureGate at="inner" />
              </AIAvailabilityProvider>
            </AIAvailabilityProvider>
          </FormattingProvider>
        </IntlProvider>
      </AuthenticatedUserProvider>
    </QueryClientProvider>,
  );
  await settle();
  // A second provider would hand the inner surface its own gate, and with it
  // a second dialog the outer surfaces cannot see or close.
  expect(gates.get("outer")).toBeDefined();
  expect(gates.get("inner")).toBe(gates.get("outer"));
  queryClient.clear();
});

const { AIProviderSettingsBoundary } =
  await import("@/routes/_protected.admin/-components/organization/ai-provider-settings-boundary");

const surfaceBoundaries = {
  panel: ({ children }: PropsWithChildren) => (
    <>
      <AIUnavailableDialogTrigger />
      {children}
    </>
  ),
  page: RequireAIKey,
  settings: AIProviderSettingsBoundary,
};

const renderSurface = (
  Boundary: (props: PropsWithChildren) => ReactNode,
  children: ReactNode = <button type="button">{messages.common.cancel}</button>,
) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const gates = new Map<"gate", ReturnType<typeof useAIKeyGate>>();
  const Capture = () => {
    gates.set("gate", useAIKeyGate());
    return null;
  };
  render(
    <QueryClientProvider client={queryClient}>
      <AuthenticatedUserProvider
        user={{
          activeOrganizationId: "org-1",
          email: "member@example.test",
          id: "user-1",
          image: null,
          name: "Member",
          preferredName: null,
          timezoneId: "UTC",
          wordEditShortcut: null,
        }}
      >
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <FormattingProvider locale="en" timeZone="UTC">
            <AIAvailabilityProvider>
              <Capture />
              <Boundary>{children}</Boundary>
            </AIAvailabilityProvider>
          </FormattingProvider>
        </IntlProvider>
      </AuthenticatedUserProvider>
    </QueryClientProvider>,
  );
  return { queryClient, gates };
};

// These are the production admission boundaries mounted by the three surfaces;
// send remains independently authorized by the API.
const roleSurfaceCases = Object.keys(roles).flatMap((role) =>
  Object.entries(surfaceBoundaries).map(([surface, Boundary]) => ({
    role,
    surface,
    Boundary,
  })),
);

test.each(roleSurfaceCases)(
  "$role × $surface: chat admission renders and settings follow configuration permission",
  async ({ role, surface, Boundary }) => {
    instanceProvisioned = true;
    providerConfiguration = isOrganizationManagementRole(role)
      ? "allowed"
      : "permission_required";
    const { queryClient, gates } = renderSurface(Boundary);
    await settle();
    const visible =
      surface !== "settings" || isOrganizationManagementRole(role);
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: messages.common.cancel }) !== null,
      ).toBe(visible);
    });
    expect(
      screen.queryByText(messages.ai.keyRequired.accountRestricted),
    ).toBeNull();
    expect(
      screen.queryByText(messages.ai.keyRequired.permissionRequired),
    ).toBeNull();
    expect(await gates.get("gate")?.ensureAIAvailable()).toBe(true);
    expect(aiConfigRequests).toBe(0);
    queryClient.clear();
  },
);

const unavailableSurfaceCases = Object.entries(surfaceBoundaries)
  .filter(([surface]) => surface !== "settings")
  .flatMap(([surface, Boundary]) =>
    ["unreadable", "403", "500"].map((failure) => ({
      surface,
      Boundary,
      failure,
    })),
  );

test.each(unavailableSurfaceCases)(
  "$surface preserves chat and blocks sends while availability is $failure, then retries",
  async ({ Boundary, failure }) => {
    unavailableReason =
      failure === "unreadable" ? "unreadable" : "provider_not_configured";
    availabilityStatus = failure === "unreadable" ? 200 : Number(failure);
    const { queryClient, gates } = renderSurface(Boundary);
    expect(
      await screen.findByText(messages.chat.sendErrorProviderUnavailable),
    ).toBeDefined();
    const chatControl = screen.getByRole("button", {
      name: messages.common.cancel,
    });
    expect(chatControl).toBeDefined();
    const gate = gates.get("gate");
    expect(gate).toBeDefined();
    let proceeded = true;
    await act(async () => {
      proceeded = (await gate?.ensureAIAvailable()) ?? true;
      gate?.openAIKeyDialog();
      gate?.openIfAIUnavailable();
    });
    expect(proceeded).toBe(false);
    expect(aiConfigRequests).toBe(0);
    expect(
      screen.queryByRole("heading", { name: messages.ai.keyRequired.title }),
    ).toBeNull();
    unavailableReason = "provider_not_configured";
    availabilityStatus = 200;
    instanceProvisioned = true;
    fireEvent.click(
      screen.getByRole("button", { name: messages.common.retry }),
    );
    await waitFor(() => {
      expect(
        screen.queryByText(messages.chat.sendErrorProviderUnavailable),
      ).toBeNull();
    });
    expect(await gates.get("gate")?.ensureAIAvailable()).toBe(true);
    expect(screen.getByRole("button", { name: messages.common.cancel })).toBe(
      chatControl,
    );
    queryClient.clear();
  },
);

test("a failed availability refresh cannot reuse a cached successful provider read", async () => {
  instanceProvisioned = true;
  const { queryClient, gates } = renderSurface(RequireAIKey);
  expect(
    await screen.findByRole("button", { name: messages.common.cancel }),
  ).toBeDefined();
  expect(await gates.get("gate")?.ensureAIAvailable()).toBe(true);
  availabilityStatus = 500;
  await act(async () => {
    await queryClient.invalidateQueries();
  });
  expect(
    await screen.findByText(messages.chat.sendErrorProviderUnavailable),
  ).toBeDefined();
  let proceeded = true;
  await act(async () => {
    proceeded = (await gates.get("gate")?.ensureAIAvailable()) ?? true;
  });
  expect(proceeded).toBe(false);
  expect(aiConfigRequests).toBe(0);
  queryClient.clear();
});

test("settings admission shows loading feedback before mounting permitted controls", async () => {
  const admission = Promise.withResolvers<undefined>();
  availabilityHold = admission.promise;
  const { queryClient } = renderSurface(AIProviderSettingsBoundary);
  expect(screen.getByRole("status").textContent).toContain(
    messages.common.loading,
  );
  expect(
    screen.queryByRole("button", { name: messages.common.cancel }),
  ).toBeNull();
  expect(aiConfigRequests).toBe(0);
  await act(async () => {
    admission.resolve(undefined);
  });
  expect(
    await screen.findByRole("button", { name: messages.common.cancel }),
  ).toBeDefined();
  queryClient.clear();
});

const settingsReadFailures = [403, 500].flatMap((status) =>
  Object.values(AI_PROVIDER_CONFIGURATION).map((capability) => ({
    status,
    capability,
  })),
);

test.each(settingsReadFailures)(
  "settings admission read $status shows retry feedback and recovers to $capability",
  async ({ status, capability }) => {
    availabilityStatus = status;
    const { queryClient } = renderSurface(AIProviderSettingsBoundary);
    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.getByText(messages.common.somethingWentWrong)).toBeDefined();
    expect(
      screen.queryByRole("button", { name: messages.common.cancel }),
    ).toBeNull();
    expect(aiConfigRequests).toBe(0);
    availabilityStatus = 200;
    providerConfiguration = capability;
    fireEvent.click(
      screen.getByRole("button", { name: messages.common.retry }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
    });
    expect(
      screen.queryByRole("button", { name: messages.common.cancel }) !== null,
    ).toBe(capability === "allowed");
    queryClient.clear();
  },
);

test("settings admission reports failed refreshes instead of retaining cached management permission", async () => {
  const { queryClient } = renderSurface(AIProviderSettingsBoundary);
  expect(
    await screen.findByRole("button", { name: messages.common.cancel }),
  ).toBeDefined();
  availabilityStatus = 500;
  await act(async () => {
    await queryClient.invalidateQueries();
  });
  expect(await screen.findByRole("alert")).toBeDefined();
  expect(
    screen.queryByRole("button", { name: messages.common.cancel }),
  ).toBeNull();
  availabilityStatus = 200;
  providerConfiguration = "permission_required";
  fireEvent.click(screen.getByRole("button", { name: messages.common.retry }));
  await waitFor(() => {
    expect(screen.queryByRole("alert")).toBeNull();
  });
  expect(
    screen.queryByRole("button", { name: messages.common.cancel }),
  ).toBeNull();
  queryClient.clear();
});

const { ChatThreadTestRouter } = await import("@/lib/chat-thread-test-router");
const { toChatThreadId } = await import("@/lib/chat-thread-ref");
const { ChatEditorProvider, useChatEditor, CHAT_SEND_SENT, CHAT_SEND_KEPT } =
  await import("./chat-editor-provider");
const { composerText } = await import("./chat-editor-source");
const { ChatInputSurface } = await import("./chat-input-surface");
const { LandingLayout } = await import("@stll/ui/landing");

const canaryThread = {
  scope: "global",
  threadId: toChatThreadId("availability-composer"),
} as const;

type CanaryComposerProps = {
  controllers: Map<"editor", ReturnType<typeof useChatEditor>>;
  sends: string[];
};

const CanaryComposer = ({ controllers, sends }: CanaryComposerProps) => {
  const controller = useChatEditor({ threadRef: canaryThread });
  controllers.set("editor", controller);
  const { availability, ensureAIAvailable } = useAIKeyGate();
  return (
    <LandingLayout
      hero={
        <ChatInputSurface
          controller={controller}
          sendDisabled={availability !== "available"}
          variant="large"
          reservedCommands={{ hasPersistedThread: false }}
          onSubmit={async (draft) => {
            if (!(await ensureAIAvailable())) {
              return CHAT_SEND_KEPT;
            }
            sends.push(draft.html);
            return CHAT_SEND_SENT;
          }}
        />
      }
    >
      {null}
    </LandingLayout>
  );
};

const renderCanaryComposer = () => {
  const controllers = new Map<"editor", ReturnType<typeof useChatEditor>>();
  const sends: string[] = [];
  const surface = renderSurface(
    RequireAIKey,
    <ChatThreadTestRouter>
      <ChatEditorProvider>
        <CanaryComposer controllers={controllers} sends={sends} />
      </ChatEditorProvider>
    </ChatThreadTestRouter>,
  );
  return { ...surface, controllers, sends };
};

const composerAvailabilityCases = [
  { type: "available" } as const,
  ...Object.values(AI_UNAVAILABLE_REASON).map(
    (reason) => ({ type: "unavailable", reason }) as const,
  ),
  ...[403, 500].map((status) => ({ type: "readFailed", status }) as const),
];

test.each(composerAvailabilityCases)(
  "the real chat textbox stays editable and sends follow provider state: %j",
  async (state) => {
    switch (state.type) {
      case "available":
        instanceProvisioned = true;
        break;
      case "unavailable":
        unavailableReason = state.reason;
        break;
      case "readFailed":
        availabilityStatus = state.status;
        break;
    }
    const { queryClient, controllers, sends } = renderCanaryComposer();
    const textbox = await screen.findByRole("textbox", {
      name: messages.chat.placeholder,
    });
    await settle();
    expect(textbox.getAttribute("contenteditable")).toBe("true");
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => {
      controllers
        .get("editor")
        ?.setContent(composerText("Which clauses need revision?"));
    });
    const send = screen.getByRole("button", { name: messages.chat.sendPrompt });
    expect(send.hasAttribute("disabled")).toBe(state.type !== "available");
    fireEvent.keyDown(textbox, { key: "Enter" });
    await settle();
    expect(sends.length).toBe(state.type === "available" ? 1 : 0);
    if (state.type !== "available") {
      expect(textbox.textContent).toContain("Which clauses need revision?");
      unavailableReason = "provider_not_configured";
      availabilityStatus = 200;
      instanceProvisioned = true;
      fireEvent.click(
        screen.getByRole("button", { name: messages.common.retry }),
      );
      await waitFor(() => {
        expect(send.hasAttribute("disabled")).toBe(false);
      });
      expect(
        screen.getByRole("textbox", { name: messages.chat.placeholder }),
      ).toBe(textbox);
      expect(textbox.textContent).toContain("Which clauses need revision?");
      fireEvent.click(send);
      await waitFor(() => {
        expect(sends.length).toBe(1);
      });
    }
    queryClient.clear();
  },
);

test("the real chat textbox mounts during a pending availability read", async () => {
  const admission = Promise.withResolvers<undefined>();
  availabilityHold = admission.promise;
  const { queryClient, controllers, sends } = renderCanaryComposer();
  const textbox = await screen.findByRole("textbox", {
    name: messages.chat.placeholder,
  });
  await act(async () => {
    controllers
      .get("editor")
      ?.setContent(composerText("Which clauses need revision?"));
  });
  expect(
    screen
      .getByRole("button", { name: messages.chat.sendPrompt })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(textbox.getAttribute("contenteditable")).toBe("true");
  expect(sends.length).toBe(0);
  instanceProvisioned = true;
  await act(async () => {
    admission.resolve(undefined);
  });
  await waitFor(() => {
    expect(
      screen
        .getByRole("button", { name: messages.chat.sendPrompt })
        .hasAttribute("disabled"),
    ).toBe(false);
  });
  expect(screen.getByRole("textbox", { name: messages.chat.placeholder })).toBe(
    textbox,
  );
  queryClient.clear();
});
