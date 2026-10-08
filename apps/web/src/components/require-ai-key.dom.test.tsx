import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost:3000/law/cz/cases/1" });

const originalFetch = globalThis.fetch;
let configStatus = 200;
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.startsWith("/api/auth/")) {
      return Response.json(null);
    }
    if (url.pathname.endsWith("/organization-settings/ai-availability")) {
      return Response.json({ available: false });
    }
    if (url.pathname.endsWith("/organization-settings/ai-config")) {
      return configStatus === 200
        ? Response.json({ providers: [], roleModels: {} })
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
const { AIAvailabilityProvider, AIUnavailableDialogTrigger } =
  await import("./require-ai-key");

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await GlobalRegistrator.unregister();
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
