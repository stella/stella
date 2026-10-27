import type { PropsWithChildren, ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

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
let instanceProvisioned = false;
let providerConfiguration:
  "allowed" | "permission_required" | "account_restricted" = "allowed";
let aiConfigRequests = 0;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.startsWith("/api/auth/")) {
      return Response.json(null);
    }
    if (url.pathname.endsWith("/organization-settings/ai-availability")) {
      if (availabilityStatus !== 200) {
        return Response.json(
          { error: "Unavailable" },
          { status: availabilityStatus },
        );
      }
      return Response.json(
        instanceProvisioned
          ? { ...aiAvailableResponse(), providerConfiguration }
          : aiUnavailableResponse({ providerConfiguration }),
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
  instanceProvisioned = false;
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
  "an automatically opened AI key dialog stays closed after dismissal (config read %d, %s)",
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

const renderSurface = (Boundary: (props: PropsWithChildren) => ReactNode) => {
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
              <Boundary>
                <button type="button">{messages.common.cancel}</button>
              </Boundary>
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

test.each([403, 500])(
  "availability read %d leaves chat send and the full page usable",
  async (status) => {
    availabilityStatus = status;
    const { queryClient, gates } = renderSurface(RequireAIKey);
    expect(
      await screen.findByRole("button", { name: messages.common.cancel }),
    ).toBeDefined();
    expect(await gates.get("gate")?.ensureAIAvailable()).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(aiConfigRequests).toBe(0);
    queryClient.clear();
  },
);
