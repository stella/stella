import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law/cz/cases/1" });

const originalFetch = globalThis.fetch;
let configStatus = 200;
let providerConfiguration:
  | "allowed"
  | "permission_required"
  | "account_restricted" = "allowed";
let aiConfigRequests = 0;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.startsWith("/api/auth/")) {
      return Response.json(null);
    }
    if (url.pathname.endsWith("/organization-settings/ai-availability")) {
      return Response.json({
        available: false,
        instanceProvisioned: false,
        orgConfigured: false,
        unavailableReason: "provider_not_configured",
        providerConfiguration,
        deferredServiceTierAvailable: false,
        mockAnswers: false,
      });
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
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { AIAvailabilityProvider, AIUnavailableDialogTrigger, useAIKeyGate } =
  await import("./require-ai-key");

afterEach(() => {
  cleanup();
  providerConfiguration = "allowed";
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
      expect(screen.getByText("Something went wrong")).toBeDefined();
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
  "%s capability renders guidance without opening or reading AI config",
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

    expect(await screen.findByText(message)).toBeDefined();
    await settle();
    expect(
      screen.queryByRole("heading", { name: "Connect AI provider" }),
    ).toBeNull();
    expect(aiConfigRequests).toBe(0);
    queryClient.clear();
  },
);

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
