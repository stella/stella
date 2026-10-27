import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import type { TimeEntrySuggestion } from "@stll/api-contract/time-entry-types";
import { Temporal } from "@stll/time";

import type { MyTimeEntry } from "@/features/my-week/my-week-day";
import messages from "@/i18n/langs/en.json";
import type { MyTimeSuggestionRange as MySuggestionRange } from "@/lib/workspaces/queries/my-time-suggestions";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/time" });

const { act, useState } = await import("react");
const { cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
  await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { roleOptions } = await import("@/lib/auth-queries");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { weekOf } = await import("@/features/my-week/my-week.logic");
const { MyWeek } = await import("@/features/my-week/my-week");

const ORGANIZATION_ID = "organization-1";
const USER_ID = "user-1";
const LEASE_MATTER = {
  id: "matter-lease",
  name: "Harbour lease",
  reference: "M-1",
};
const SUPPLY_MATTER = {
  id: "matter-supply",
  name: "Supply agreement",
  reference: "M-2",
};
// Entries can be edited only inside the edit window, so the fixture lives in
// the current week.
const WEEK = weekOf(Temporal.Now.plainDateISO("UTC").toString());
const MONDAY = WEEK.start;

const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await act(async () => {
    cleanup();
  });
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const draftEntry = (overrides: Partial<MyTimeEntry> = {}): MyTimeEntry =>
  ({
    id: "entry-1",
    activityGroup: "client",
    workspaceId: LEASE_MATTER.id,
    workspaceName: LEASE_MATTER.name,
    workspaceReference: LEASE_MATTER.reference,
    dateWorked: MONDAY,
    durationMinutes: 30,
    billedMinutes: 30,
    narrative: "Review lease schedule",
    narrativeLanguage: null,
    billable: true,
    status: "draft",
    source: "manual",
    timerStartedAt: null,
    ...overrides,
  }) satisfies MyTimeEntry;

const suggestion = {
  fingerprint: "a".repeat(64),
  startedAt: `${MONDAY}T09:00:00.000Z`,
  endedAt: `${MONDAY}T09:10:00.000Z`,
  durationMinutes: 15,
  engagedMinutes: 15,
  alreadyCovered: false,
  billableByDefault: true,
  signalCount: 2,
  evidence: [
    {
      type: "chat_thread",
      id: "thread-1",
      title: "Indemnity cap",
      messageCount: 2,
      signals: [
        {
          source: "chat_message",
          resourceId: "message-1",
          timestamp: `${MONDAY}T09:00:00.000Z`,
        },
        {
          source: "chat_message",
          resourceId: "message-2",
          timestamp: `${MONDAY}T09:10:00.000Z`,
        },
      ],
    },
  ],
} satisfies TimeEntrySuggestion;

type ApiCall = {
  method: string;
  path: string;
  search: URLSearchParams;
  body: unknown;
};

/**
 * A fake API over in-memory rows, answering with the contract shapes: the
 * personal entry range with its per-day totals, the suggestion range, a
 * decision (an accept creates the entry), and an entry update.
 */
const serveWeek = ({
  entries,
  suggestions,
}: {
  entries: MyTimeEntry[];
  suggestions: {
    matter: typeof LEASE_MATTER;
    date: string;
    items: TimeEntrySuggestion[];
  }[];
}) => {
  const calls: ApiCall[] = [];
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json" },
    });
  const inRange = (date: string, start: string, end: string) =>
    date >= start && date <= end;

  const entryPage = (start: string, end: string) => {
    const items = entries.filter((entry) =>
      inRange(entry.dateWorked, start, end),
    );
    const days = [...new Set(items.map((entry) => entry.dateWorked))]
      .toSorted()
      .map((dateWorked) => {
        const day = items.filter((entry) => entry.dateWorked === dateWorked);
        return {
          dateWorked,
          loggedMinutes: day.reduce(
            (sum, entry) => sum + entry.durationMinutes,
            0,
          ),
          billableMinutes: day.reduce(
            (sum, entry) => sum + (entry.billable ? entry.durationMinutes : 0),
            0,
          ),
        };
      });
    const loggedMinutes = days.reduce((sum, day) => sum + day.loggedMinutes, 0);
    return {
      items,
      nextCursor: null,
      limit: 200,
      days,
      loggedTodayMinutes: loggedMinutes,
      dailyTargetMinutes: null,
      leftTodayMinutes: null,
    };
  };

  const suggestionRange = (start: string, end: string): MySuggestionRange => {
    const byDate = new Map<
      string,
      MySuggestionRange["days"][number]["matters"]
    >();
    for (const group of suggestions) {
      if (!inRange(group.date, start, end) || group.items.length === 0) {
        continue;
      }
      const earlier = byDate.get(group.date);
      byDate.set(group.date, [
        ...(earlier === undefined ? [] : earlier),
        {
          matter: group.matter,
          activeMinutes: group.items.reduce(
            (sum, item) => sum + item.durationMinutes,
            0,
          ),
          items: group.items,
        },
      ]);
    }
    return {
      startDate: start,
      endDate: end,
      days: [...byDate.entries()]
        // ISO dates sort by code point.
        .toSorted(([a], [b]) => (a < b ? -1 : 1))
        .map(([date, matters]) => ({ date, matters })),
    };
  };

  const decide = (workspaceId: string, body: Record<string, unknown>) => {
    const group = suggestions.find(
      (candidate) =>
        candidate.matter.id === workspaceId && candidate.date === body["date"],
    );
    const decided = group?.items.find(
      (item) => item.fingerprint === body["fingerprint"],
    );
    if (!group || !decided) {
      return new Response(JSON.stringify({ code: "not_found" }), {
        status: 404,
      });
    }
    group.items = group.items.filter((item) => item !== decided);
    const decision = body["decision"] as Record<string, unknown>;
    if (decision["type"] !== "accept") {
      return json({
        fingerprint: decided.fingerprint,
        status: "dismissed",
        timeEntryId: null,
      });
    }
    const created = draftEntry({
      id: `entry-${entries.length + 1}`,
      workspaceId: group.matter.id,
      workspaceName: group.matter.name,
      workspaceReference: group.matter.reference,
      dateWorked: group.date,
      durationMinutes: Number(decision["durationMinutes"]),
      narrative: String(decision["narrative"]),
      billable:
        typeof decision["billable"] === "boolean"
          ? decision["billable"]
          : decided.billableByDefault,
      source: "suggested",
    });
    entries.push(created);
    return json({
      fingerprint: decided.fingerprint,
      status: "accepted",
      timeEntryId: created.id,
    });
  };

  const update = (body: Record<string, unknown>) => {
    const index = entries.findIndex((entry) => entry.id === body["id"]);
    const current = entries[index];
    if (!current) {
      return new Response(JSON.stringify({ code: "not_found" }), {
        status: 404,
      });
    }
    entries[index] = {
      ...current,
      durationMinutes: Number(
        body["durationMinutes"] ?? current.durationMinutes,
      ),
      narrative: String(body["narrative"] ?? current.narrative),
      billable:
        typeof body["billable"] === "boolean"
          ? body["billable"]
          : current.billable,
    };
    return json({ id: current.id });
  };

  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const text = request.method === "GET" ? "" : await request.text();
      const body: unknown = text === "" ? null : JSON.parse(text);
      const path = url.pathname.replace(/^.*\/v1/u, "");
      calls.push({
        method: request.method,
        path,
        search: url.searchParams,
        body,
      });
      const start =
        url.searchParams.get("date") ?? url.searchParams.get("startDate") ?? "";
      const end = url.searchParams.get("endDate") ?? start;
      if (request.method === "GET" && path === "/time-entries/me") {
        return json(entryPage(start, end));
      }
      if (request.method === "GET" && path === "/time-entries/me/suggestions") {
        return json(suggestionRange(start, end));
      }
      const decision =
        /^\/time-entries\/([^/]+)\/suggestions\/decisions$/u.exec(path);
      if (request.method === "POST" && decision?.[1]) {
        return decide(decision[1], body as Record<string, unknown>);
      }
      if (
        request.method === "PATCH" &&
        /^\/time-entries\/[^/]+\/?$/u.test(path)
      ) {
        return update(body as Record<string, unknown>);
      }
      return new Response(JSON.stringify({ code: "not_found" }), {
        status: 404,
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  return calls;
};

const Harness = ({ initialDate }: { initialDate: string }) => {
  const [date, setDate] = useState(initialDate);
  return (
    <MyWeek
      date={date}
      onSelectDate={setDate}
      onToday={() => setDate(MONDAY)}
      organizationId={ORGANIZATION_ID}
      timezoneId="UTC"
      userId={USER_ID}
    />
  );
};

const mount = (initialDate = MONDAY) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(roleOptions.queryKey, "owner");
  const root = createRootRoute({
    component: () => <Harness initialDate={initialDate} />,
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/time"] }),
  });
  render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en-GB" timeZone="UTC">
          <AuthenticatedUserProvider
            user={{
              activeOrganizationId: ORGANIZATION_ID,
              email: "timekeeper@example.test",
              id: USER_ID,
              image: null,
              name: "Timekeeper",
              preferredName: null,
              timezoneId: "UTC",
              wordEditShortcut: null,
            }}
          >
            <RouterProvider router={router} />
          </AuthenticatedUserProvider>
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
};

const weekTotalsText = (logged: string, billable: string) =>
  messages.timesheets.week.totals
    .replace("{logged}", () => logged)
    .replace("{billable}", () => billable);

const acceptLabel = `${messages.common.accept}: ${suggestion.evidence[0]?.title}`;

describe("my week", () => {
  test("moves between weeks and loads each week's entries and suggestions", async () => {
    const calls = serveWeek({ entries: [draftEntry()], suggestions: [] });
    mount();

    expect(await screen.findByText("Review lease schedule")).toBeTruthy();
    const nextMonday = Temporal.PlainDate.from(MONDAY)
      .add({ weeks: 1 })
      .toString();
    const nextSunday = Temporal.PlainDate.from(nextMonday)
      .add({ days: 6 })
      .toString();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: messages.timesheets.week.nextWeek }),
      );
    });

    expect(
      await screen.findByText(messages.timesheets.week.noActivity),
    ).toBeTruthy();
    expect(screen.queryByText("Review lease schedule") === null).toBe(true);
    const ranges = calls
      .filter(({ method }) => method === "GET")
      .map(({ path, search }) => ({
        path,
        start: search.get("date") ?? search.get("startDate"),
        end: search.get("endDate"),
      }));
    for (const path of ["/time-entries/me", "/time-entries/me/suggestions"]) {
      expect(ranges).toContainEqual({ path, start: MONDAY, end: WEEK.end });
      expect(ranges).toContainEqual({
        path,
        start: nextMonday,
        end: nextSunday,
      });
    }

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: messages.timesheets.week.previousWeek,
        }),
      );
    });
    expect(await screen.findByText("Review lease schedule")).toBeTruthy();
  });

  test("accepting a suggestion logs it in its matter, removes it and updates the totals", async () => {
    const calls = serveWeek({
      entries: [draftEntry()],
      suggestions: [
        { matter: SUPPLY_MATTER, date: MONDAY, items: [suggestion] },
      ],
    });
    mount();

    const row = await screen.findByRole("button", { name: acceptLabel });
    expect(within(row).getByText(SUPPLY_MATTER.name)).toBeTruthy();
    expect(screen.getByText(weekTotalsText("30 min", "30 min"))).toBeTruthy();

    await act(async () => {
      fireEvent.click(row);
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: acceptLabel }) === null).toBe(
        true,
      );
    });
    expect(
      await screen.findByText(weekTotalsText("45 min", "45 min")),
    ).toBeTruthy();
    expect(screen.getByText(messages.timesheets.week.allLogged)).toBeTruthy();
    const decision = calls.find(({ method }) => method === "POST");
    expect(decision?.path).toBe(
      `/time-entries/${SUPPLY_MATTER.id}/suggestions/decisions`,
    );
    expect(decision?.body).toMatchObject({
      fingerprint: suggestion.fingerprint,
      date: MONDAY,
      timezoneId: "UTC",
      decision: {
        type: "accept",
        durationMinutes: 15,
        narrative: "Indemnity cap",
      },
    });
    // Billability left as suggested is the server's call, never sent.
    expect(decision?.body).not.toHaveProperty("decision.billable");
  });

  test("editing a draft entry saves it in its matter and updates the totals", async () => {
    const calls = serveWeek({
      entries: [draftEntry({ narrativeLanguage: "cs" })],
      suggestions: [],
    });
    mount();

    const edit = await screen.findByRole("button", {
      name: `${messages.common.edit}: Review lease schedule`,
    });
    await act(async () => {
      fireEvent.click(edit);
    });
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.change(
        within(dialog).getByLabelText(messages.billing.minutes),
        {
          target: { value: "45" },
        },
      );
    });
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: messages.common.save }),
      );
    });

    expect(
      await screen.findByText(weekTotalsText("45 min", "45 min")),
    ).toBeTruthy();
    const patch = calls.find(({ method }) => method === "PATCH");
    expect(patch?.path).toMatch(
      new RegExp(`^/time-entries/${LEASE_MATTER.id}/?$`, "u"),
    );
    // Changing only the duration keeps the narrative's stored language.
    expect(patch?.body).toMatchObject({
      id: "entry-1",
      durationMinutes: 45,
      narrativeLanguage: "cs",
    });
  });

  test("only drafts are editable from the week", async () => {
    serveWeek({
      entries: [
        draftEntry({
          id: "entry-approved",
          narrative: "Approved call",
          status: "approved",
        }),
      ],
      suggestions: [],
    });
    mount();

    expect(await screen.findByText("Approved call")).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: `${messages.common.edit}: Approved call`,
      }) === null,
    ).toBe(true);
  });
});
