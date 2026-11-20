import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { OrganizationAIAvailability } from "@stll/api-contract/organization-ai-availability";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import {
  aiAvailableResponse,
  aiUnavailableResponse,
} from "@/__fixtures__/ai-availability";
import messages from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "http://localhost:3000/chat/new" });
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => Response.json({}), {
  preconnect: originalFetch.preconnect,
});

const { act, cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { QueryClientProvider } = await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { AnalyticsContext } = await import("@/lib/analytics/provider");
const { noopAnalytics } = await import("@/lib/analytics/noop");
const { roleOptions } = await import("@/lib/auth-queries");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { aiAvailabilityOptions } =
  await import("@/lib/organization/ai-config-queries");
const { getOrganizationCreationOwner } =
  await import("@/lib/organization/creation-state");
const { markOrganizationSetupPending, ORGANIZATION_SETUP_PENDING_KEY } =
  await import("@/lib/organization/setup-pending");
const { browserStateStorage } = await import("@/lib/account/browser-storage");
const { userStorageKey } = await import("@/lib/account/user-scoped-storage");
const { toSafeId } = await import("@/lib/safe-id");
const { createAppQueryClient } = await import("@/lib/react-query");
const { OrganizationSetupNudge } = await import("./organization-setup-nudge");

const NEW_ORGANIZATION = "new-organization";
const OTHER_ORGANIZATION = "other-organization";
const copy = messages.organizationSetup;

afterEach(() => {
  cleanup();
  browserStateStorage("local").removeItem(
    userStorageKey(ORGANIZATION_SETUP_PENDING_KEY),
  );
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  cleanup();
  await act(async () => await Promise.resolve());
  await unregisterDomEnvironment();
});

type MountOptions = {
  activeOrganizationId?: string;
  availability?: OrganizationAIAvailability;
};

const mount = async ({
  activeOrganizationId = NEW_ORGANIZATION,
  availability = aiAvailableResponse(),
}: MountOptions = {}) => {
  const queryClient = createAppQueryClient();
  queryClient.setQueryData(roleOptions.queryKey, "owner");
  queryClient.setQueryData(
    aiAvailabilityOptions({ organizationId: activeOrganizationId }).queryKey,
    availability,
  );
  const root = router.createRootRoute({
    component: () => <OrganizationSetupNudge />,
  });
  const appRouter = router.createRouter({
    history: router.createMemoryHistory({ initialEntries: ["/"] }),
    isServer: false,
    routeTree: root,
  });
  await appRouter.load();
  render(
    <QueryClientProvider client={queryClient}>
      <AnalyticsContext value={noopAnalytics}>
        <AuthenticatedUserProvider
          user={{
            activeOrganizationId,
            id: "user",
            email: "owner@example.test",
            image: null,
            name: "Owner",
            preferredName: null,
            timezoneId: "UTC",
            wordEditShortcut: null,
          }}
        >
          <IntlProvider locale="en" messages={messages} timeZone="UTC">
            <router.RouterProvider router={appRouter} />
          </IntlProvider>
        </AuthenticatedUserProvider>
      </AnalyticsContext>
    </QueryClientProvider>,
  );
};

test("a just-created organization offers invites and optional AI keys", async () => {
  // Creation marks the organization, before anyone switches to it.
  const owner = getOrganizationCreationOwner(
    createAppQueryClient(),
    toSafeId("user"),
  );
  owner.setName("New firm");
  const intent = owner.begin(() => "creation-key");
  if (intent === null) {
    panic("A named draft begins its creation");
  }
  owner.created(intent, {
    organizationId: NEW_ORGANIZATION,
    name: "New firm",
    slug: "new-firm",
  });
  await mount();
  expect(await screen.findByText(copy.title)).toBeDefined();
  expect(screen.getByText(copy.invite)).toBeDefined();
  expect(
    screen.getByRole("button", { name: messages.common.invite }),
  ).toBeDefined();
  expect(screen.getByText(copy.aiOptional)).toBeDefined();
  expect(
    screen.getByRole("link", { name: copy.aiAction }).getAttribute("href"),
  ).toBe("/settings/organization/ai");
});

test("an organization that needs its own key says so", async () => {
  markOrganizationSetupPending(NEW_ORGANIZATION);
  await mount({
    availability: aiUnavailableResponse({
      unavailableReason: "own_key_required",
    }),
  });
  expect(await screen.findByText(copy.aiRequired)).toBeDefined();
  expect(screen.queryByText(copy.aiOptional)).toBeNull();
});

test("someone who may not configure AI is not sent to its settings", async () => {
  markOrganizationSetupPending(NEW_ORGANIZATION);
  await mount({
    availability: {
      ...aiAvailableResponse(),
      providerConfiguration: "permission_required",
    },
  });
  expect(await screen.findByText(copy.title)).toBeDefined();
  expect(screen.queryByRole("link", { name: copy.aiAction })).toBeNull();
});

test("closing the prompt keeps it closed for that organization", async () => {
  markOrganizationSetupPending(NEW_ORGANIZATION);
  markOrganizationSetupPending(OTHER_ORGANIZATION);
  await mount();
  fireEvent.click(
    await screen.findByRole("button", { name: messages.common.dismiss }),
  );
  expect(screen.queryByText(copy.title)).toBeNull();
  cleanup();
  await mount();
  expect(screen.queryByText(copy.title)).toBeNull();
  cleanup();
  await mount({ activeOrganizationId: OTHER_ORGANIZATION });
  expect(await screen.findByText(copy.title)).toBeDefined();
});

test("an organization the user did not just create shows nothing", async () => {
  await mount({ activeOrganizationId: OTHER_ORGANIZATION });
  await act(async () => await Promise.resolve());
  expect(screen.queryByText(copy.title)).toBeNull();
});
