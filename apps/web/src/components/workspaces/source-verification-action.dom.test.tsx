import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import { parseTimeZoneId } from "@stll/time";

import arabicMessages from "@/i18n/langs/ar.json";
import englishMessages from "@/i18n/langs/en.json";
import type { OrganizationSettings } from "@/queries/organization-settings";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const sourceId = "019a0000-0000-7000-8000-000000000004";
const requests: Request[] = [];
const fetchBoundary = spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/auth/")) {
        return Response.json(null);
      }
      requests.push(request);
      if (
        request.method === "PATCH" &&
        url.pathname.endsWith("/item-sources")
      ) {
        return Response.json({ id: sourceId });
      }
      throw new Error(
        `Unexpected source action request: ${request.method} ${url.pathname}`,
      );
    },
    { preconnect: () => undefined },
  ),
);
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { organizationSettingsOptions } =
  await import("@/queries/organization-settings");
const { legalListKeys } = await import("@/lib/workspaces/queries/legal-lists");
const { SourceVerificationAction } =
  await import("./source-verification-action");

const principal = { organizationId: "org-fixture", userId: "user-fixture" };
const workspaceId = "019a0000-0000-7000-8000-000000000001";
const listId = "019a0000-0000-7000-8000-000000000002";
const itemEntityId = "019a0000-0000-7000-8000-000000000003";
const settings = {
  declaredFeatureIds: ["legal-lists", "list-verification"],
  deploymentFeatures: { legalLists: true },
  capabilities: {},
  documentProcessingMode: "off",
  matterNumberPattern: "{year}/{number}",
  matterNumberPadding: 3,
  practiceJurisdictions: [],
  promptCachingEnabled: true,
  managedAIResidency: "eu",
  memoryExtractionEnabled: false,
  timeMinimumUnitMinutes: 1,
  timeEditWindowDays: 30,
  timeLockedThroughMonth: null,
  timeNarrativeRequired: false,
  timeZone:
    parseTimeZoneId("UTC") ??
    panic("UTC fixture must be a supported time zone"),
  timeZoneSource: "organization",
} satisfies OrganizationSettings;

const mountAction = ({
  capabilities,
  verified = false,
  locale = "en",
}: {
  capabilities: OrganizationSettings["capabilities"];
  verified?: boolean;
  locale?: "en" | "ar";
}) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  client.setQueryData(organizationSettingsOptions(principal).queryKey, {
    ...settings,
    capabilities,
  });
  const invalidation = spyOn(client, "invalidateQueries");
  const messages = locale === "ar" ? arabicMessages : englishMessages;
  const mounted = render(
    <IntlProvider locale={locale} messages={messages} timeZone="UTC">
      <QueryClientProvider client={client}>
        <AuthenticatedUserProvider
          user={{
            activeOrganizationId: principal.organizationId,
            id: principal.userId,
            email: "member@example.test",
            image: null,
            name: "Fixture member",
            preferredName: null,
            timezoneId: "UTC",
            wordEditShortcut: null,
          }}
        >
          <SourceVerificationAction
            workspaceId={workspaceId}
            listId={listId}
            itemEntityId={itemEntityId}
            sourceId={sourceId}
            verified={verified}
          />
        </AuthenticatedUserProvider>
      </QueryClientProvider>
    </IntlProvider>,
  );
  return { mounted, client, invalidation, messages };
};

afterEach(() => {
  cleanup();
  requests.length = 0;
});
afterAll(async () => {
  fetchBoundary.mockRestore();
  await unregisterDomEnvironment();
});

for (const capabilities of [
  {},
  { "legal-lists": { status: "enabled" } },
  {
    "legal-lists": { status: "enabled" },
    "list-verification": { status: "hidden" },
  },
  {
    "legal-lists": { status: "hidden" },
    "list-verification": { status: "enabled" },
  },
] as const) {
  test(`source verification stays hidden for ${JSON.stringify(capabilities)}`, () => {
    const { mounted, client } = mountAction({ capabilities });
    expect(
      mounted.queryByRole("button", { name: englishMessages.common.accept }),
    ).toBeNull();
    expect(requests).toHaveLength(0);
    mounted.unmount();
    client.clear();
  });
}

for (const { locale } of [{ locale: "en" }, { locale: "ar" }] as const) {
  test(`${locale}: an enabled caller verifies the source and refreshes its history`, async () => {
    const { mounted, client, invalidation, messages } = mountAction({
      capabilities: {
        "legal-lists": { status: "enabled" },
        "list-verification": { status: "enabled" },
      },
      locale,
    });
    fireEvent.click(
      mounted.getByRole("button", { name: messages.common.accept }),
    );
    await waitFor(() => expect(invalidation).toHaveBeenCalledTimes(2));
    expect(requests).toHaveLength(1);
    const request = requests.at(0);
    expect(request?.method).toBe("PATCH");
    expect(new URL(request?.url ?? "").pathname).toBe(
      `/v1/lists/${workspaceId}/item-sources`,
    );
    expect(await request?.json()).toEqual({
      id: sourceId,
      listId,
      itemEntityId,
      status: "verified",
    });
    expect(invalidation).toHaveBeenCalledWith({
      queryKey: legalListKeys.sources(workspaceId, listId, itemEntityId),
    });
    expect(invalidation).toHaveBeenCalledWith({
      queryKey: legalListKeys.activity(workspaceId, listId, itemEntityId),
    });
    await act(async () => {
      client.setQueryData(organizationSettingsOptions(principal).queryKey, {
        ...settings,
        capabilities: {},
      });
    });
    await waitFor(() =>
      expect(
        mounted.queryByRole("button", { name: messages.common.accept }),
      ).toBeNull(),
    );
    expect(requests).toHaveLength(1);
    mounted.unmount();
    client.clear();
  });
}

test("an already verified source cannot issue another PATCH", () => {
  const { mounted, client } = mountAction({
    capabilities: {
      "legal-lists": { status: "enabled" },
      "list-verification": { status: "enabled" },
    },
    verified: true,
  });
  const button = mounted.getByRole("button", {
    name: englishMessages.common.accept,
  });
  expect(button.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(button);
  expect(requests).toHaveLength(0);
  mounted.unmount();
  client.clear();
});
