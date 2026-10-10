import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";
import * as v from "valibot";

import { sleep } from "@stll/concurrency/sleep";

import type { PracticeJurisdiction } from "@/lib/jurisdictions";

GlobalRegistrator.register({
  url: "http://localhost:3000/settings/organization",
});

const ORGANIZATION = "jurisdictions-card-org";
const ORGANIZATION_SETTINGS_CALLER = {
  organizationId: ORGANIZATION,
  userId: "user",
};

type PendingWrite = {
  body: unknown;
  response: ReturnType<typeof Promise.withResolvers<Response>>;
};

const originalFetch = globalThis.fetch;
const writes: PendingWrite[] = [];
const server: { practiceJurisdictions: unknown } = {
  practiceJurisdictions: [],
};
let settingsReads = 0;

const settingsBody = () => ({
  documentProcessingMode: "standard",
  matterNumberPattern: "{YYYY}-{NNN}",
  matterNumberPadding: 3,
  practiceJurisdictions: server.practiceJurisdictions,
  promptCachingEnabled: true,
  managedAIResidency: "eu",
  memoryExtractionEnabled: false,
  timeMinimumUnitMinutes: 6,
  timeEditWindowDays: 30,
  timeLockedThroughMonth: null,
  timeNarrativeRequired: false,
});

globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path.endsWith("/api/auth/get-session")) {
      return Response.json({
        session: { userId: "user", activeOrganizationId: ORGANIZATION },
        user: { id: "user", email: "admin@example.com", name: "Admin" },
      });
    }
    if (request.method === "GET" && path.endsWith("/organization-settings")) {
      settingsReads += 1;
      return Response.json(settingsBody());
    }
    if (
      request.method === "POST" &&
      path.endsWith("/organization-settings/practice-jurisdictions")
    ) {
      const response = Promise.withResolvers<Response>();
      const body = v.parse(
        v.object({ practiceJurisdictions: v.unknown() }),
        await request.json(),
      );
      writes.push({ body: body.practiceJurisdictions, response });
      return await response.promise;
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  },
  { preconnect: () => undefined },
);

const testing = await import("@testing-library/react");
const query = await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { organizationSettingsOptions } =
  await import("@/lib/organization/settings-queries");
const { OrganizationJurisdictionsCard } = await import("./jurisdictions-card");

afterEach(() => {
  testing.cleanup();
  writes.length = 0;
  server.practiceJurisdictions = [];
  settingsReads = 0;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await GlobalRegistrator.unregister();
});

const CZ: PracticeJurisdiction = { countryCode: "CZ", isPrimary: true };
const SK: PracticeJurisdiction = { countryCode: "SK", isPrimary: false };

// Lets queued work (a scoped mutation continuing, a refetch) reach the
// transport before asserting what was sent.
const drain = async () => await testing.act(async () => await sleep(0));

const mountCard = async () => {
  const client = new query.QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  const view = testing.render(
    <query.QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <AuthenticatedUserProvider
            user={{
              activeOrganizationId: ORGANIZATION,
              email: "admin@example.com",
              id: "user",
              image: null,
              name: "Admin",
              preferredName: null,
              timezoneId: "UTC",
              wordEditShortcut: null,
            }}
          >
            <OrganizationJurisdictionsCard />
          </AuthenticatedUserProvider>
        </FormattingProvider>
      </IntlProvider>
    </query.QueryClientProvider>,
  );
  await testing.waitFor(() => {
    expect(
      client.getQueryState(
        organizationSettingsOptions(ORGANIZATION_SETTINGS_CALLER).queryKey,
      )?.status,
    ).toBe("success");
  });
  const countryButton = (name: RegExp) => {
    const button = view.getByText(name).closest("button");
    if (!button) {
      throw new Error("Expected a country selection button");
    }
    return button;
  };
  return { client, view, countryButton };
};

// The picker renders a "make primary" star for every selected country once
// two or more are selected; its pressed styling marks the primary one.
const displayedSelection = (view: ReturnType<typeof testing.render>) =>
  view.queryAllByLabelText(/^Make .* primary/u).map((star) => ({
    name: star.getAttribute("aria-label"),
    isPrimary: star.className.split(/\s+/u).includes("text-primary"),
  }));

const EXPECTED_DISPLAY = [
  { name: "Make Czechia primary", isPrimary: true },
  { name: "Make Slovakia primary", isPrimary: false },
];

const nextWrite = async (index: number) => {
  await testing.waitFor(() => expect(writes.length).toBeGreaterThan(index));
  const write = writes.at(index);
  if (!write) {
    throw new Error("Expected a pending practice-jurisdictions write");
  }
  return write;
};

const commit = async (write: PendingWrite) =>
  await testing.act(async () => {
    server.practiceJurisdictions = write.body;
    write.response.resolve(Response.json({ success: true }));
  });

const fail = async (write: PendingWrite) =>
  await testing.act(async () =>
    write.response.resolve(
      Response.json(
        { error: { code: "INTERNAL", message: "write failed" } },
        { status: 500 },
      ),
    ),
  );

type SettleOrder = "oldest-first" | "newest-first";
type FirstOutcome = "commits" | "fails";

// Settles whichever writes are on the wire, oldest or newest first, until
// none remain. Only the first write may fail; later ones commit.
const settleAll = async (order: SettleOrder, firstOutcome: FirstOutcome) => {
  const settled = new Set<PendingWrite>();
  for (;;) {
    const open = writes.filter((write) => !settled.has(write));
    const write = order === "oldest-first" ? open.at(0) : open.at(-1);
    if (!write) {
      return;
    }
    settled.add(write);
    if (write === writes.at(0) && firstOutcome === "fails") {
      await fail(write);
    } else {
      await commit(write);
    }
    await drain();
  }
};

const SCHEDULES: readonly (readonly [SettleOrder, FirstOutcome])[] = [
  ["oldest-first", "commits"],
  ["oldest-first", "fails"],
  ["newest-first", "commits"],
  ["newest-first", "fails"],
];

test.each(SCHEDULES)(
  "a selection made while the previous write is pending is persisted last (%s, first write %s)",
  async (order, firstOutcome) => {
    const { client, view, countryButton } = await mountCard();

    testing.fireEvent.click(countryButton(/^Czechia/u));
    const first = await nextWrite(0);
    expect(first.body).toEqual([CZ]);

    testing.fireEvent.click(countryButton(/^Slovakia/u));
    await drain();
    // The newer selection waits for the earlier write to settle, and the
    // card shows it meanwhile.
    expect(writes).toHaveLength(1);
    expect(displayedSelection(view)).toEqual(EXPECTED_DISPLAY);

    const readsBefore = settingsReads;
    await settleAll(order, firstOutcome);
    await testing.waitFor(() =>
      expect(settingsReads).toBeGreaterThan(readsBefore),
    );
    await drain();

    expect(writes.map((write) => write.body)).toEqual([[CZ], [CZ, SK]]);
    expect(server.practiceJurisdictions).toEqual([CZ, SK]);
    expect(
      client.getQueryData(
        organizationSettingsOptions(ORGANIZATION_SETTINGS_CALLER).queryKey,
      )?.practiceJurisdictions,
    ).toEqual([CZ, SK]);
    expect(displayedSelection(view)).toEqual(EXPECTED_DISPLAY);
    client.clear();
  },
);

test("the card keeps the newest selection while the older write's refetch lands", async () => {
  const { client, view, countryButton } = await mountCard();
  testing.fireEvent.click(countryButton(/^Czechia/u));
  const first = await nextWrite(0);
  testing.fireEvent.click(countryButton(/^Slovakia/u));
  await drain();

  const readsBefore = settingsReads;
  await commit(first);
  const second = await nextWrite(1);
  // The older write's refetch returns the older value ([CZ]) while the newer
  // write is still in flight.
  await testing.waitFor(() =>
    expect(settingsReads).toBeGreaterThan(readsBefore),
  );
  await drain();
  expect(
    client.getQueryData(
      organizationSettingsOptions(ORGANIZATION_SETTINGS_CALLER).queryKey,
    )?.practiceJurisdictions,
  ).toEqual([CZ]);
  expect(displayedSelection(view)).toEqual(EXPECTED_DISPLAY);

  await commit(second);
  await drain();
  client.clear();
});
