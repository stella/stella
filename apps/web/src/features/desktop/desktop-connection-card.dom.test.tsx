import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Result } from "better-result";
import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";

import { desktopPresenceSchema } from "@stll/api-contract/desktop-presence";
import type { DesktopPresence } from "@stll/api-contract/desktop-presence";

import messages from "@/i18n/langs/en.json";
import type { AuthenticatedUser } from "@/lib/authenticated-user-context";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/settings/account" });

const originalFetch = globalThis.fetch;
// Auth initializes during imports; DOM tests own the network boundary too.
const idleFetch = Object.assign(async () => Response.json(null), {
  preconnect: originalFetch.preconnect,
});
globalThis.fetch = idleFetch;

const { act } = await import("react");
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { DesktopConnectionCard } =
  await import("@/features/desktop/desktop-connection-card");
const { desktopPresenceOptions } = await import("./desktop-presence");
const desktopBridge = await import("@/lib/desktop-bridge");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");

const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(async () => {
  await act(async () => {
    cleanup();
    for (const client of clients) {
      client.clear();
    }
    clients.length = 0;
    globalThis.fetch = idleFetch;
  });
  mock.restore();
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const user = {
  id: "desktop-card-test-user",
  activeOrganizationId: "desktop-card-test-organization",
  email: "desktop-card@example.test",
  name: "Desktop card test",
  image: null,
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
} satisfies AuthenticatedUser;

const desktop = {
  version: "1.0.0",
  protocol: 2,
  lastSeenAt: "2026-10-06T07:00:00.000Z",
};
const PRESENCE_FIXTURES = {
  current: { type: "current", desktop },
  outdated: { type: "outdated", desktop },
  not_connected: { type: "not_connected", desktop },
  none: { type: "none" },
} as const satisfies {
  [Type in DesktopPresence["type"]]: Extract<DesktopPresence, { type: Type }>;
};

const mountCard = (presence: DesktopPresence) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryOnMount: false, refetchOnMount: false },
    },
  });
  clients.push(client);
  client.setQueryData(
    desktopPresenceOptions({
      userId: user.id,
      organizationId: user.activeOrganizationId,
    }).queryKey,
    presence,
  );
  return render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <AuthenticatedUserProvider user={user}>
          <DesktopConnectionCard />
        </AuthenticatedUserProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
};

// Presence is recorded per account, not per computer: no account-level state
// may hide this computer's connect while it holds no link of its own.
test.each(
  desktopPresenceSchema.options.map(({ entries }) => entries.type.literal),
)(
  "%s account presence without a pending approval still connects this computer",
  async (presence) => {
    const started: Awaited<
      ReturnType<typeof desktopBridge.linkDesktopAccount>
    > = Result.ok({ status: "started" });
    const link = spyOn(desktopBridge, "linkDesktopAccount").mockResolvedValue(
      started,
    );
    const view = mountCard(PRESENCE_FIXTURES[presence]);
    const connect = view.getByRole("button", {
      name: messages.settings.account.desktopConnectInstalled,
    });
    await act(async () => {
      fireEvent.click(connect);
    });
    expect(link).toHaveBeenCalledTimes(1);
  },
);
