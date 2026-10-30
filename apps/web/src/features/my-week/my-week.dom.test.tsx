import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";

import { TIME_ENTRIES_APPROVAL_BATCH_MAX } from "@stll/api-contract/limits";
import type { TimeSubmitRefusal } from "@stll/api-contract/time-entries";
import type { TimeEntrySuggestion } from "@stll/api-contract/time-entry-types";
import { Temporal } from "@stll/time";

import type { MyTimeEntry } from "@/features/my-week/my-week-day";
import messages from "@/i18n/langs/en.json";
import { toSafeId } from "@/lib/safe-id";
import type { MyTimeSuggestionRange as MySuggestionRange } from "@/lib/workspaces/queries/my-time-suggestions";
import { unregisterDomEnvironment } from "@/test-dom-environment";

import { TIME_TRACKING_ENTRIES_SELECTOR } from "../../../e2e/marketing/capture-readiness";

GlobalRegistrator.register({ url: "http://localhost:3000/time" });

const { act, useState } = await import("react");
const { cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
  await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { stellaToast } = await import("@stll/ui/toast");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { roleOptions } = await import("@/lib/auth-queries");
const { timeEntriesKeys } =
  await import("@/lib/workspaces/queries/time-entries");
const { invoicesKeys } = await import("@/lib/workspaces/queries/invoices");
const { workspacesNavigationOptions } =
  await import("@/lib/workspaces/queries");
const { groupedChatThreadsOptions } = await import("@/features/chat/queries");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { weekOf } = await import("@/components/billing/work-week.logic");
const { MyWeek } = await import("@/features/my-week/my-week");

const ORGANIZATION_ID = "organization-1";
const USER_ID = "user-1";
const LEASE_MATTER = {
  id: toSafeId<"workspace">("matter-lease"),
  name: "Harbour lease",
  reference: "M-1",
};
const SUPPLY_MATTER = {
  id: toSafeId<"workspace">("matter-supply"),
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

type ClientEntry = Extract<MyTimeEntry, { activityGroup: "client" }>;

const draftEntry = (overrides: Partial<ClientEntry> = {}): ClientEntry =>
  ({
    id: toSafeId<"timeEntry">("entry-1"),
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
    activityCode: null,
    status: "draft",
    source: "manual",
    timerStartedAt: null,
    returnComment: null,
    ...overrides,
  }) satisfies ClientEntry;

const THREAD_TITLE = "Indemnity cap";

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
      title: THREAD_TITLE,
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
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const serveWeek = ({
  entries,
  suggestions,
  refusals = {},
  pendingCount = 0,
  pageSize = 200,
  failLaterPages = false,
  failSubmitDates = [],
  failCreate = false,
  noRate = false,
  rejectRate = false,
}: {
  entries: MyTimeEntry[];
  failCreate?: boolean;
  noRate?: boolean;
  rejectRate?: boolean;
  /** Drafts the fake API refuses to submit, with the reason it gives. */
  refusals?: Record<string, TimeSubmitRefusal>;
  /** Submitted entries waiting for the signed-in approver. */
  pendingCount?: number;
  pageSize?: number;
  /** Fail every page request after the first. */
  failLaterPages?: boolean;
  /** Single dates whose submission request fails. */
  failSubmitDates?: string[];
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

  const entryPage = (start: string, end: string, cursor: string | null) => {
    const inWeek = entries.filter((entry) =>
      inRange(entry.dateWorked, start, end),
    );
    const offset = cursor === null ? 0 : Number(cursor);
    const items = inWeek.slice(offset, offset + pageSize);
    const more = offset + pageSize < inWeek.length;
    // Day totals cover the whole week on every page, as the API's do.
    const days = [...new Set(inWeek.map((entry) => entry.dateWorked))]
      .toSorted()
      .map((dateWorked) => {
        const day = inWeek.filter((entry) => entry.dateWorked === dateWorked);
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
      nextCursor: more ? String(offset + pageSize) : null,
      limit: pageSize,
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
      let day = byDate.get(group.date);
      if (day === undefined) {
        day = [];
        byDate.set(group.date, day);
      }
      day.push({
        matter: group.matter,
        activeMinutes: group.items.reduce(
          (sum, item) => sum + item.durationMinutes,
          0,
        ),
        items: group.items,
      });
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
    const decisionInput = body["decision"];
    const decision: Record<string, unknown> = isRecord(decisionInput)
      ? decisionInput
      : {};
    if (decision["type"] !== "accept") {
      return json({
        fingerprint: decided.fingerprint,
        status: "dismissed",
        timeEntryId: null,
      });
    }
    const created = draftEntry({
      id: toSafeId<"timeEntry">(`entry-${entries.length + 1}`),
      workspaceId: group.matter.id,
      workspaceName: group.matter.name,
      workspaceReference: group.matter.reference,
      dateWorked: group.date,
      durationMinutes: Number(decision["durationMinutes"]),
      narrative:
        typeof decision["narrative"] === "string" ? decision["narrative"] : "",
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

  // Every draft in the range moves unless the fixture refuses it.
  const submit = (body: Record<string, unknown>) => {
    const start =
      typeof body["startDate"] === "string" ? body["startDate"] : "";
    const end = typeof body["endDate"] === "string" ? body["endDate"] : "";
    if (start === end && failSubmitDates.includes(start)) {
      return new Response("unavailable", { status: 503 });
    }
    const drafts = entries
      .map((entry, index) => ({ entry, index }))
      .filter(
        ({ entry }) =>
          entry.status === "draft" && inRange(entry.dateWorked, start, end),
      );
    // The API refuses a range with more drafts than one batch moves.
    if (drafts.length > TIME_ENTRIES_APPROVAL_BATCH_MAX) {
      return new Response(
        JSON.stringify({
          code: "too_many_entries",
          message: "Too many drafts in these dates",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }
    const results = drafts.map(({ entry, index }) => {
      const reason = refusals[entry.id];
      if (reason !== undefined) {
        return { id: entry.id, status: "refused" as const, reason };
      }
      const status =
        body["approve"] === true
          ? ("approved" as const)
          : ("submitted" as const);
      entries[index] = { ...entry, status };
      return { id: entry.id, status };
    });
    return json({ results });
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
      narrative:
        typeof body["narrative"] === "string"
          ? body["narrative"]
          : current.narrative,
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
      if (request.method === "GET" && /^\/rates\/[^/]+\/resolve$/u.test(path)) {
        return json(
          noRate
            ? { hourlyRate: null, currency: null }
            : { hourlyRate: 10_000, currency: "EUR" },
        );
      }
      const start =
        url.searchParams.get("date") ?? url.searchParams.get("startDate") ?? "";
      const end = url.searchParams.get("endDate") ?? start;
      if (request.method === "GET" && path === "/time-entries/me") {
        const cursor = url.searchParams.get("cursor");
        if (failLaterPages && cursor !== null) {
          return new Response("unavailable", { status: 503 });
        }
        return json(entryPage(start, end, cursor));
      }
      if (request.method === "GET" && path === "/time-entries/me/suggestions") {
        return json(suggestionRange(start, end));
      }
      const decision =
        /^\/time-entries\/([^/]+)\/suggestions\/decisions$/u.exec(path);
      if (request.method === "POST" && decision?.[1] && isRecord(body)) {
        return decide(decision[1], body);
      }
      const create = /^\/time-entries\/([^/]+)\/?$/u.exec(path);
      if (request.method === "PUT" && create?.[1] && isRecord(body)) {
        if (rejectRate && body["billable"] === true) {
          return new Response(
            JSON.stringify({
              code: "time_entry_rate_required",
              message: "Changed server diagnostic",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        if (failCreate) {
          return new Response("unavailable", { status: 503 });
        }
        const matter = [LEASE_MATTER, SUPPLY_MATTER].find(
          ({ id }) => id === create[1],
        );
        if (
          !matter ||
          typeof body["dateWorked"] !== "string" ||
          typeof body["narrative"] !== "string"
        ) {
          return new Response("invalid entry", { status: 400 });
        }
        const entry = draftEntry({
          id: toSafeId<"timeEntry">(`manual-${entries.length + 1}`),
          workspaceId: matter.id,
          workspaceName: matter.name,
          dateWorked: body["dateWorked"],
          durationMinutes: Number(body["durationMinutes"]),
          narrative: body["narrative"],
          billable: body["billable"] === true,
        });
        entries.push(entry);
        return json({ id: entry.id });
      }
      if (
        request.method === "PATCH" &&
        /^\/time-entries\/[^/]+\/?$/u.test(path) &&
        isRecord(body)
      ) {
        return update(body);
      }
      if (
        request.method === "POST" &&
        path === "/time-entries/me/submissions" &&
        isRecord(body)
      ) {
        return submit(body);
      }
      if (request.method === "GET" && path === "/time-entries/approval-queue") {
        return json({ items: [], nextCursor: null, limit: 1, pendingCount });
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

const mount = (initialDate = MONDAY, role: "owner" | "member" = "owner") => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(roleOptions.queryKey, role);
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
  return client;
};

const seedMatters = (client: InstanceType<typeof QueryClient>) => {
  // The matters the picker offers, as the sidebar already holds them.
  client.setQueryData(
    workspacesNavigationOptions({
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
    }).queryKey,
    {
      workspaces: [LEASE_MATTER, SUPPLY_MATTER].map((matter) => ({
        ...matter,
        client: null,
        clientId: null,
        color: null,
        defaultViewId: null,
        lastActivityAt: new Date(`${MONDAY}T08:00:00.000Z`),
        status: "active" as const,
      })),
      features: { timeBilling: true },
    },
  );
  const history = groupedChatThreadsOptions({
    activeOrganizationId: ORGANIZATION_ID,
    userId: USER_ID,
  });
  client.setQueryData(history.queryKey, {
    pageParams: [history.initialPageParam],
    pages: [{ global: [], nextCursor: null, workspaces: [] }],
  });
};

const weekTotalsText = (logged: string, billable: string) =>
  messages.timesheets.week.totals
    .replace("{logged}", () => logged)
    .replace("{billable}", () => billable);

const acceptLabel = `${messages.common.accept}: ${THREAD_TITLE}`;

const pickCreateMatter = async (dialog: HTMLElement) => {
  const picker = within(dialog).getByLabelText(messages.common.matter);
  await act(async () => {
    picker.focus();
    fireEvent.keyDown(picker, { key: "ArrowDown" });
  });
  const option = await screen.findByRole("option", {
    name: SUPPLY_MATTER.name,
  });
  await act(async () => {
    fireEvent.click(option);
  });
};

const submitCreateForm = (dialog: HTMLElement) => {
  const form = within(dialog)
    .getByRole("button", { name: messages.common.save })
    .closest("form");
  if (form === null) {
    throw new TypeError("Expected the time entry form");
  }
  fireEvent.submit(form);
};

const fillCreateEntry = async (dialog: HTMLElement) => {
  await act(async () => {
    fireEvent.change(within(dialog).getByLabelText(messages.billing.minutes), {
      target: { value: "45" },
    });
    fireEvent.change(
      within(dialog).getByLabelText(messages.common.description),
      {
        target: { value: "  Príprava žaloby – skúšobný spis  " },
      },
    );
    fireEvent.click(
      within(dialog).getByRole("checkbox", { name: messages.billing.billable }),
    );
  });
};

describe("my week", () => {
  test("creates from the header in the chosen matter and refreshes day entries and week totals", async () => {
    const calls = serveWeek({ entries: [draftEntry()], suggestions: [] });
    const client = mount();
    seedMatters(client);
    const logTime = await screen.findByRole("button", {
      name: messages.common.logTime,
    });
    await act(async () => {
      fireEvent.click(logTime);
    });
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).queryByRole("button", { name: messages.common.save }),
    ).toBeNull();
    await pickCreateMatter(dialog);
    await fillCreateEntry(dialog);
    await act(async () => {
      submitCreateForm(dialog);
      submitCreateForm(dialog);
    });
    expect(
      await screen.findByText("Príprava žaloby – skúšobný spis"),
    ).toBeTruthy();
    expect(
      await screen.findByText(weekTotalsText("1 hr 15 min", "1 hr 15 min")),
    ).toBeTruthy();
    const writes = calls.filter(({ method }) => method === "PUT");
    expect(writes).toHaveLength(1);
    expect(writes.at(0)).toMatchObject({
      path: `/time-entries/${SUPPLY_MATTER.id}`,
      body: {
        dateWorked: MONDAY,
        durationMinutes: 45,
        narrative: "Príprava žaloby – skúšobný spis",
        billable: true,
        timezoneId: "UTC",
      },
    });
  });

  test("selects a matter with the keyboard and submits the native form", async () => {
    const calls = serveWeek({ entries: [draftEntry()], suggestions: [] });
    const client = mount();
    seedMatters(client);
    const logTime = await screen.findByRole("button", {
      name: messages.common.logTime,
    });
    await act(async () => {
      fireEvent.click(logTime);
    });
    const dialog = await screen.findByRole("dialog");
    const picker = within(dialog).getByLabelText(messages.common.matter);
    await act(async () => {
      picker.focus();
      fireEvent.change(picker, { target: { value: SUPPLY_MATTER.name } });
      fireEvent.keyDown(picker, { key: "ArrowDown" });
    });
    await screen.findByRole("option", { name: SUPPLY_MATTER.name });
    await act(async () => {
      fireEvent.keyDown(picker, { key: "ArrowDown" });
    });
    await act(async () => {
      fireEvent.keyDown(picker, { key: "Enter" });
    });
    await fillCreateEntry(dialog);
    await act(async () => {
      submitCreateForm(dialog);
    });
    await screen.findByText("Príprava žaloby – skúšobný spis");
    expect(calls.filter(({ method }) => method === "PUT")).toHaveLength(1);
  });

  test.each([10, 100])(
    "create refresh requests stay bounded with %i existing entries",
    async (count) => {
      const entries = Array.from({ length: count }, (_, index) =>
        draftEntry({ id: toSafeId<"timeEntry">(`existing-${index}`) }),
      );
      const calls = serveWeek({ entries, suggestions: [], pageSize: 10 });
      const client = mount();
      seedMatters(client);
      const logTime = await screen.findByRole("button", {
        name: messages.common.logTime,
      });
      await act(async () => {
        fireEvent.click(logTime);
      });
      const dialog = await screen.findByRole("dialog");
      await pickCreateMatter(dialog);
      await fillCreateEntry(dialog);
      await act(async () => {
        submitCreateForm(dialog);
      });
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      for (const path of ["/time-entries/me", "/time-entries/me/suggestions"]) {
        expect(
          calls.filter((call) => call.method === "GET" && call.path === path),
        ).toHaveLength(2);
      }
      expect(calls.filter(({ method }) => method === "PUT")).toHaveLength(1);
    },
  );

  test("the empty-day action prefills the selected day", async () => {
    const calls = serveWeek({ entries: [], suggestions: [] });
    const day = Temporal.PlainDate.from(MONDAY)
      .subtract({ weeks: 1 })
      .add({ days: 2 })
      .toString();
    const client = mount(day);
    seedMatters(client);
    await screen.findByText(messages.timesheets.week.noActivity);
    const daySection = document.querySelector(
      "section[aria-labelledby='my-week-day-title']",
    );
    if (!(daySection instanceof HTMLElement)) {
      throw new TypeError("Expected day section");
    }
    await act(async () => {
      fireEvent.click(
        within(daySection).getByRole("button", {
          name: messages.common.logTime,
        }),
      );
    });
    const dialog = await screen.findByRole("dialog");
    await pickCreateMatter(dialog);
    await fillCreateEntry(dialog);
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: messages.common.save }),
      );
    });
    await screen.findByText("Príprava žaloby – skúšobný spis");
    expect(calls.find(({ method }) => method === "PUT")?.body).toMatchObject({
      dateWorked: day,
    });
  });

  test("refuses empty description and zero duration without creating time", async () => {
    const calls = serveWeek({ entries: [draftEntry()], suggestions: [] });
    const client = mount();
    seedMatters(client);
    const logTime = await screen.findByRole("button", {
      name: messages.common.logTime,
    });
    await act(async () => {
      fireEvent.click(logTime);
    });
    const dialog = await screen.findByRole("dialog");
    await pickCreateMatter(dialog);
    const save = within(dialog).getByRole("button", {
      name: messages.common.save,
    });
    expect(save.hasAttribute("disabled")).toBe(true);
    await act(async () => {
      fireEvent.change(
        within(dialog).getByLabelText(messages.common.description),
        {
          target: { value: "Skúšobný spis" },
        },
      );
    });
    expect(save.hasAttribute("disabled")).toBe(true);
    for (const duration of ["0", "0.5", "0,5", "-1"]) {
      await act(async () => {
        fireEvent.change(
          within(dialog).getByLabelText(messages.billing.minutes),
          {
            target: { value: duration },
          },
        );
        submitCreateForm(dialog);
      });
      expect(save.hasAttribute("disabled")).toBe(true);
      expect(calls.filter(({ method }) => method === "PUT")).toHaveLength(0);
    }
    await act(async () => {
      fireEvent.change(
        within(dialog).getByLabelText(messages.billing.minutes),
        {
          target: { value: "15" },
        },
      );
    });
    expect(save.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      fireEvent.change(
        within(dialog).getByLabelText(messages.common.description),
        {
          target: { value: "   " },
        },
      );
    });
    await act(async () => {
      submitCreateForm(dialog);
    });
    expect(save.hasAttribute("disabled")).toBe(true);
    expect(calls.filter(({ method }) => method === "PUT")).toHaveLength(0);
  });

  test("keeps the create form and its values after a server failure and shows an error toast", async () => {
    const calls = serveWeek({
      entries: [draftEntry()],
      suggestions: [],
      failCreate: true,
    });
    const client = mount();
    seedMatters(client);
    const toasts = spyOn(stellaToast, "add");
    try {
      const logTime = await screen.findByRole("button", {
        name: messages.common.logTime,
      });
      await act(async () => {
        fireEvent.click(logTime);
      });
      const dialog = await screen.findByRole("dialog");
      await pickCreateMatter(dialog);
      await fillCreateEntry(dialog);
      await act(async () => {
        fireEvent.click(
          within(dialog).getByRole("button", { name: messages.common.save }),
        );
      });
      await waitFor(() => {
        expect(
          toasts.mock.calls.some(([toast]) => toast.type === "error"),
        ).toBe(true);
      });
      expect(screen.getByRole("dialog")).toBe(dialog);
      const narrative = within(dialog).getByLabelText(
        messages.common.description,
      );
      if (!(narrative instanceof HTMLTextAreaElement)) {
        throw new TypeError("Expected narrative textarea");
      }
      expect(narrative.value).toBe("  Príprava žaloby – skúšobný spis  ");
      expect(calls.filter(({ method }) => method === "PUT")).toHaveLength(1);
      expect(screen.getByText(weekTotalsText("30 min", "30 min"))).toBeTruthy();
    } finally {
      toasts.mockRestore();
    }
  });

  test("moves between weeks and loads each week's entries and suggestions", async () => {
    const calls = serveWeek({ entries: [draftEntry()], suggestions: [] });
    mount();

    expect(await screen.findByText("Review lease schedule")).toBeTruthy();
    const capturedEntries = document.querySelectorAll(
      TIME_TRACKING_ENTRIES_SELECTOR,
    );
    expect(capturedEntries).toHaveLength(1);
    expect(capturedEntries.item(0).textContent).toContain(
      "Review lease schedule",
    );
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
    expect(
      document.querySelectorAll(TIME_TRACKING_ENTRIES_SELECTOR),
    ).toHaveLength(0);
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
        // The billability the row showed is sent, so a later change to the
        // matter's default cannot flip the logged entry.
        billable: true,
      },
    });
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
      id: toSafeId<"timeEntry">("entry-1"),
      durationMinutes: 45,
      narrativeLanguage: "cs",
    });
  });

  test("a draft entry moves to another matter from its edit dialog", async () => {
    const calls = serveWeek({ entries: [draftEntry()], suggestions: [] });
    const client = mount();
    seedMatters(client);
    // Both matters' time and invoice data, opened earlier.
    for (const matter of [LEASE_MATTER, SUPPLY_MATTER]) {
      client.setQueryData(timeEntriesKeys.all(matter.id), { items: [] });
      client.setQueryData(invoicesKeys.all(matter.id), { items: [] });
    }

    const edit = await screen.findByRole("button", {
      name: `${messages.common.edit}: Review lease schedule`,
    });
    await act(async () => {
      fireEvent.click(edit);
    });
    const dialog = await screen.findByRole("dialog");
    const picker = within(dialog).getByLabelText(messages.common.matter);
    if (!(picker instanceof HTMLInputElement)) {
      throw new TypeError("Expected the matter picker input");
    }
    expect(picker.value).toBe(LEASE_MATTER.name);
    expect(
      within(dialog).queryByText(messages.billing.moveEntryHint),
    ).toBeNull();
    await act(async () => {
      picker.focus();
      fireEvent.keyDown(picker, { key: "ArrowDown" });
    });
    const supply = await screen.findByRole("option", {
      name: SUPPLY_MATTER.name,
    });
    await act(async () => {
      fireEvent.click(supply);
    });
    expect(
      await within(dialog).findByText(messages.billing.moveEntryHint),
    ).toBeTruthy();
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: messages.common.save }),
      );
    });

    await waitFor(() => {
      expect(calls.some(({ method }) => method === "PATCH")).toBe(true);
    });
    const patch = calls.find(({ method }) => method === "PATCH");
    // Sent to the matter it is in, naming the one it moves to.
    expect(patch?.path).toMatch(
      new RegExp(`^/time-entries/${LEASE_MATTER.id}/?$`, "u"),
    );
    expect(patch?.body).toMatchObject({
      id: toSafeId<"timeEntry">("entry-1"),
      moveToWorkspaceId: SUPPLY_MATTER.id,
    });
    await waitFor(() => {
      for (const matter of [LEASE_MATTER, SUPPLY_MATTER]) {
        expect(
          client.getQueryState(timeEntriesKeys.all(matter.id))?.isInvalidated,
        ).toBe(true);
        expect(
          client.getQueryState(invoicesKeys.all(matter.id))?.isInvalidated,
        ).toBe(true);
      }
    });
  });

  test("saving a draft in its own matter sends no move", async () => {
    const calls = serveWeek({ entries: [draftEntry()], suggestions: [] });
    mount();

    const edit = await screen.findByRole("button", {
      name: `${messages.common.edit}: Review lease schedule`,
    });
    await act(async () => {
      fireEvent.click(edit);
    });
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: messages.common.save }),
      );
    });

    await waitFor(() => {
      expect(calls.some(({ method }) => method === "PATCH")).toBe(true);
    });
    const patch = calls.find(({ method }) => method === "PATCH");
    expect(patch?.body).not.toHaveProperty("moveToWorkspaceId");
  });

  test.each([
    ["a logged entry", { durationMinutes: 45, timerStartedAt: null }],
    // A running timer counts zero minutes, so the day's total is zero too.
    [
      "a running timer",
      { durationMinutes: 0, timerStartedAt: `${MONDAY}T08:00:00.000Z` },
    ],
  ] as const)(
    "a day with %s on a later page is not shown as empty",
    async (_, later) => {
      const tuesday = Temporal.PlainDate.from(MONDAY)
        .add({ days: 1 })
        .toString();
      serveWeek({
        entries: [
          draftEntry(),
          draftEntry({
            id: toSafeId<"timeEntry">("entry-2"),
            dateWorked: tuesday,
            narrative: "Draft the termination notice",
            ...later,
          }),
        ],
        suggestions: [],
        pageSize: 1,
      });
      mount(tuesday);

      expect(
        await screen.findByRole("button", { name: messages.common.loadMore }),
      ).toBeTruthy();
      expect(
        screen.queryByText(messages.timesheets.week.noActivity),
      ).toBeNull();

      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: messages.common.loadMore }),
        );
      });

      expect(
        await screen.findByText("Draft the termination notice"),
      ).toBeTruthy();
      expect(
        await screen.findByText(messages.timesheets.week.allLogged),
      ).toBeTruthy();
    },
  );

  test("a failed later page says so and keeps the loaded entries", async () => {
    const tuesday = Temporal.PlainDate.from(MONDAY).add({ days: 1 }).toString();
    serveWeek({
      entries: [
        draftEntry(),
        draftEntry({
          id: toSafeId<"timeEntry">("entry-2"),
          dateWorked: tuesday,
          narrative: "Draft the termination notice",
        }),
      ],
      suggestions: [],
      pageSize: 1,
      failLaterPages: true,
    });
    const toasts = spyOn(stellaToast, "add");
    try {
      mount();

      expect(await screen.findByText("Review lease schedule")).toBeTruthy();
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: messages.common.loadMore }),
        );
      });

      await waitFor(() => {
        expect(toasts).toHaveBeenCalled();
      });
      expect(screen.getByText("Review lease schedule")).toBeTruthy();
    } finally {
      toasts.mockRestore();
    }
  });

  test("only drafts are editable from the week", async () => {
    serveWeek({
      entries: [
        draftEntry({
          id: toSafeId<"timeEntry">("entry-approved"),
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
  test("the week can be submitted while its drafts are on a page not loaded yet", async () => {
    serveWeek({
      entries: [
        draftEntry({ status: "submitted" }),
        draftEntry({
          id: toSafeId<"timeEntry">("entry-later"),
          narrative: "Later draft",
        }),
      ],
      suggestions: [],
      pageSize: 1,
    });
    mount();

    const submit = await screen.findByRole("button", {
      name: messages.timesheets.week.submitWeek,
    });
    expect(screen.queryByText("Later draft")).toBeNull();
    expect(submit.hasAttribute("disabled")).toBe(false);
  });

  test("submitting and approving refreshes the matters' time and invoice data", async () => {
    serveWeek({ entries: [draftEntry()], suggestions: [] });
    const client = mount();
    // A matter's time list and invoice prefill an approver opened earlier.
    const matterTime = timeEntriesKeys.all(LEASE_MATTER.id);
    const matterInvoices = invoicesKeys.all(LEASE_MATTER.id);
    client.setQueryData(matterTime, { items: [] });
    client.setQueryData(matterInvoices, { items: [] });

    const submitAndApprove = await screen.findByRole("button", {
      name: messages.timesheets.week.submitAndApprove,
    });
    await act(async () => {
      fireEvent.click(submitAndApprove);
    });

    await waitFor(() => {
      expect(client.getQueryState(matterTime)?.isInvalidated).toBe(true);
      expect(client.getQueryState(matterInvoices)?.isInvalidated).toBe(true);
    });
  });

  test("a member approving entries assigned to them sees what waits", async () => {
    serveWeek({ entries: [draftEntry()], suggestions: [], pendingCount: 2 });
    mount(MONDAY, "member");

    expect(await screen.findByText("2 entries to approve")).toBeTruthy();
    // Own approval stays with roles that may approve.
    expect(
      screen.queryByRole("button", {
        name: messages.timesheets.week.submitAndApprove,
      }),
    ).toBeNull();
  });

  test("a later day that fails keeps the reasons of drafts refused before it", async () => {
    const tuesday = Temporal.PlainDate.from(MONDAY).add({ days: 1 }).toString();
    const drafts = Array.from(
      { length: TIME_ENTRIES_APPROVAL_BATCH_MAX + 1 },
      (_, index) =>
        draftEntry({
          id: toSafeId<"timeEntry">(`entry-bulk-${index}`),
          narrative: `Bulk entry ${index}`,
          dateWorked: index % 2 === 0 ? MONDAY : tuesday,
        }),
    );
    serveWeek({
      entries: drafts,
      suggestions: [],
      refusals: { "entry-bulk-0": "unpriced" },
      failSubmitDates: [tuesday],
    });
    const toasts = spyOn(stellaToast, "add");
    try {
      mount();
      expect(await screen.findByText("Bulk entry 0")).toBeTruthy();
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name: messages.timesheets.week.submitWeek,
          }),
        );
      });

      // Monday moved and its refusal is explained; Tuesday's failure is said.
      expect(
        await screen.findByText(messages.timesheets.week.refusals.unpriced),
      ).toBeTruthy();
      await waitFor(() => {
        expect(toasts).toHaveBeenCalled();
      });
    } finally {
      toasts.mockRestore();
    }
  });

  test("a double click submits the week once", async () => {
    const calls = serveWeek({ entries: [draftEntry()], suggestions: [] });
    mount();

    const submit = await screen.findByRole("button", {
      name: messages.timesheets.week.submitWeek,
    });
    await act(async () => {
      fireEvent.click(submit);
      fireEvent.click(submit);
    });

    await waitFor(() => {
      expect(
        calls.filter(
          ({ method, path }) =>
            method === "POST" && path === "/time-entries/me/submissions",
        ),
      ).toHaveLength(1);
    });
  });

  test("a week with more drafts than one batch is submitted day by day", async () => {
    const tuesday = Temporal.PlainDate.from(MONDAY).add({ days: 1 }).toString();
    const drafts = Array.from(
      { length: TIME_ENTRIES_APPROVAL_BATCH_MAX + 1 },
      (_, index) =>
        draftEntry({
          id: toSafeId<"timeEntry">(`entry-bulk-${index}`),
          narrative: `Bulk entry ${index}`,
          dateWorked: index % 2 === 0 ? MONDAY : tuesday,
        }),
    );
    const calls = serveWeek({ entries: drafts, suggestions: [] });
    mount();

    expect(await screen.findByText("Bulk entry 0")).toBeTruthy();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: messages.timesheets.week.submitWeek,
        }),
      );
    });

    const submissionStarts = () =>
      calls
        .filter(
          ({ method, path }) =>
            method === "POST" && path === "/time-entries/me/submissions",
        )
        .map(({ body }) => (isRecord(body) ? body["startDate"] : null));
    // The whole week first, refused for size, then each day of it.
    await waitFor(() => {
      expect(submissionStarts()).toEqual([WEEK.start, ...WEEK.days]);
    });
    // Every draft moved, so none of the day's entries is editable any more.
    await waitFor(() => {
      expect(
        screen.queryByRole("button", {
          name: `${messages.common.edit}: Bulk entry 0`,
        }) === null,
      ).toBe(true);
    });
  });

  test("submitting the week moves its drafts, keeps refused ones editable with the reason, and locks submitted ones", async () => {
    const calls = serveWeek({
      entries: [
        draftEntry(),
        draftEntry({
          id: toSafeId<"timeEntry">("entry-2"),
          narrative: "Unpriced call",
        }),
      ],
      suggestions: [],
      refusals: { "entry-2": "unpriced" },
      pendingCount: 3,
    });
    mount();

    const editReady = `${messages.common.edit}: Review lease schedule`;
    expect(await screen.findByRole("button", { name: editReady })).toBeTruthy();
    // An approver sees what waits for them, and can approve their own week.
    expect(await screen.findByText("3 entries to approve")).toBeTruthy();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: messages.timesheets.week.submitWeek,
        }),
      );
    });

    const submission = calls.find(
      ({ method, path }) =>
        method === "POST" && path === "/time-entries/me/submissions",
    );
    expect(submission?.body).toEqual({
      startDate: WEEK.start,
      endDate: WEEK.end,
      approve: false,
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: editReady }) === null).toBe(
        true,
      );
    });
    expect(screen.getByText(/Submitted/u)).toBeTruthy();
    expect((await screen.findByRole("alert")).textContent).toBe(
      messages.timesheets.week.refusals.unpriced,
    );
    expect(
      screen.getByRole("button", {
        name: `${messages.common.edit}: Unpriced call`,
      }),
    ).toBeTruthy();
  });

  test("an approver of their own time submits and approves in one step", async () => {
    const calls = serveWeek({ entries: [draftEntry()], suggestions: [] });
    mount();

    const submitAndApprove = await screen.findByRole("button", {
      name: messages.timesheets.week.submitAndApprove,
    });
    await act(async () => {
      fireEvent.click(submitAndApprove);
    });
    await waitFor(() => {
      expect(
        calls.find(({ path }) => path === "/time-entries/me/submissions")?.body,
      ).toMatchObject({ approve: true });
    });
    expect(await screen.findByText(/Approved/u)).toBeTruthy();
  });

  test("a returned draft shows the approver's reason", async () => {
    serveWeek({
      entries: [draftEntry({ returnComment: "Split the call from drafting" })],
      suggestions: [],
    });
    mount();

    expect(
      await screen.findByText(
        messages.timesheets.week.returned.replace(
          "{comment}",
          () => "Split the call from drafting",
        ),
      ),
    ).toBeTruthy();
  });
});

describe("missing effective rate", () => {
  const openCreate = async () => {
    const client = mount();
    seedMatters(client);
    const trigger = await screen.findByRole("button", {
      name: messages.common.logTime,
    });
    await act(async () => {
      fireEvent.click(trigger);
    });
    const dialog = await screen.findByRole("dialog");
    await pickCreateMatter(dialog);
    await fillCreateEntry(dialog);
    return dialog;
  };

  test("blocks billable save without a rate and explicitly saves non-billable time", async () => {
    const calls = serveWeek({
      entries: [draftEntry()],
      suggestions: [],
      noRate: true,
    });
    const dialog = await openCreate();
    await within(dialog).findByText(
      messages.billing.rates.effectiveRateRequired,
    );
    const save = within(dialog).getByRole("button", {
      name: messages.common.save,
    });
    expect(save.hasAttribute("disabled")).toBe(true);
    await act(async () => {
      submitCreateForm(dialog);
    });
    expect(calls.filter(({ method }) => method === "PUT")).toHaveLength(0);
    expect(
      within(dialog)
        .getByRole("link", { name: messages.billing.rates.addRate })
        .getAttribute("href"),
    ).toContain("rates=manage");
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: messages.billing.rates.logNonBillable,
        }),
      );
    });
    await act(async () => {
      fireEvent.click(save);
    });
    await waitFor(() =>
      expect(calls.find(({ method }) => method === "PUT")?.body).toMatchObject({
        billable: false,
      }),
    );
  });

  test("maps a typed API 400 to the same inline rate error", async () => {
    const calls = serveWeek({
      entries: [draftEntry()],
      suggestions: [],
      rejectRate: true,
    });
    const dialog = await openCreate();
    const save = within(dialog).getByRole("button", {
      name: messages.common.save,
    });
    await waitFor(() => expect(save.hasAttribute("disabled")).toBe(false));
    await act(async () => {
      fireEvent.click(save);
    });
    await within(dialog).findByText(
      messages.billing.rates.effectiveRateRequired,
    );
    expect(calls.filter(({ method }) => method === "PUT")).toHaveLength(1);
    expect(save.hasAttribute("disabled")).toBe(true);
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: messages.billing.rates.logNonBillable,
        }),
      );
    });
    await act(async () => {
      fireEvent.click(save);
    });
    await waitFor(() =>
      expect(calls.filter(({ method }) => method === "PUT")).toHaveLength(2),
    );
    expect(
      calls.filter(({ method }) => method === "PUT").at(1)?.body,
    ).toMatchObject({
      billable: false,
    });
  });

  test("blocks a billable edit without an effective rate", async () => {
    const calls = serveWeek({
      entries: [draftEntry()],
      suggestions: [],
      noRate: true,
    });
    mount();
    const edit = await screen.findByRole("button", {
      name: `${messages.common.edit}: Review lease schedule`,
    });
    await act(async () => {
      fireEvent.click(edit);
    });
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(
      messages.billing.rates.effectiveRateRequired,
    );
    expect(
      within(dialog)
        .getByRole("button", { name: messages.common.save })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(calls.filter(({ method }) => method === "PATCH")).toHaveLength(0);
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: messages.billing.rates.logNonBillable,
        }),
      );
    });
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: messages.common.save }),
      );
    });
    await waitFor(() =>
      expect(
        calls.find(({ method }) => method === "PATCH")?.body,
      ).toMatchObject({ billable: false }),
    );
  });
});
