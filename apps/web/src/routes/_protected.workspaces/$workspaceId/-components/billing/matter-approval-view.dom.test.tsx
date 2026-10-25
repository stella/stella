import { Suspense } from "react";
import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { QueryClient as Client } from "@tanstack/react-query";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";

import type { TimeEntry } from "@stll/api-contract/time-entry-types";
import { cents } from "@stll/money";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({
  url: "http://localhost:3000/workspaces/matter-1/timesheets",
});

const WORKSPACE = "matter-1";
const USER = "approver-1";

const entry = (id: string, overrides: Partial<TimeEntry> = {}): TimeEntry =>
  ({
    id,
    source: "manual",
    status: "draft",
    activityCode: null,
    billable: true,
    billedMinutes: 90,
    createdAt: "2026-10-08T10:00:00Z",
    currency: "CZK",
    dateWorked: "2026-10-08",
    durationMinutes: 90,
    invoiceNarrative: null,
    narrative: `Narrative ${id}`,
    narrativeLanguage: null,
    noCharge: false,
    rateAtEntry: 300_000,
    taskCode: null,
    timerStartedAt: null,
    timerStoppedAt: null,
    timezoneId: "Europe/Prague",
    updatedAt: null,
    userId: "timekeeper-1",
    userName: "Timekeeper One",
    workItemId: null,
    workItemReference: null,
    ...overrides,
  }) satisfies TimeEntry;

type Refusal = "unpriced" | "time_period_locked" | "invalid_entry";
type Server = {
  entries: Map<string, TimeEntry>;
  refusals: Map<string, Refusal>;
  approveCalls: string[][];
  prefillReads: number;
  listReads: number;
};
const server: Server = {
  entries: new Map(),
  refusals: new Map(),
  approveCalls: [],
  prefillReads: 0,
  listReads: 0,
};

// The API's own shapes: a list page, a per-entry approval outcome, and the
// invoice prefill of a matter whose time is all still in draft.
const emptyPrefill = {
  currency: "CZK",
  language: "cs",
  invoiceDate: "2026-10-25",
  taxableSupplyDate: "2026-10-25",
  dueDays: 14,
  dueDaysSource: "default",
  seller: null,
  sellerSource: "none",
  buyer: { buyerName: null },
  buyerSource: "none",
  vat: {
    vatTreatment: "domestic_vat",
    vatRateBps: 0,
    reason: "no_seller_profile",
  },
  vatRatePeriods: [],
  billingMode: "hourly",
  flatFeeAmount: null,
  timeEntries: [],
  expenses: [],
};

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.endsWith("/approve")) {
      const { ids } = v.parse(
        v.object({ ids: v.array(v.string()) }),
        await request.json(),
      );
      server.approveCalls.push(ids);
      const results = ids.map((id) => {
        const reason = server.refusals.get(id);
        if (reason) {
          return { id, status: "refused", reason };
        }
        const current = server.entries.get(id);
        if (current) {
          server.entries.set(id, { ...current, status: "approved" });
        }
        return { id, status: "approved" };
      });
      return Response.json({ results });
    }
    if (request.method === "GET" && url.pathname.endsWith("/prefill")) {
      server.prefillReads += 1;
      return Response.json(emptyPrefill);
    }
    if (
      request.method === "GET" &&
      url.pathname.endsWith(`/time-entries/${WORKSPACE}`)
    ) {
      server.listReads += 1;
      const status = url.searchParams.get("status");
      return Response.json({
        items: [...server.entries.values()].filter(
          (item) => item.status === status,
        ),
        limit: 100,
        nextCursor: null,
      });
    }
    if (
      request.method === "GET" &&
      url.pathname.endsWith(`/expenses/${WORKSPACE}`)
    ) {
      return Response.json({ items: [], limit: 100, nextCursor: null });
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  },
  { preconnect: () => undefined },
);

const testing = await import("@testing-library/react");
const query = await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { rootKeys } = await import("@/lib/auth-queries");
const { invoicePrefillOptions } =
  await import("@/lib/workspaces/queries/invoices");
const { timeEntriesOptions } =
  await import("@/lib/workspaces/queries/time-entries");
const { expensesOptions } = await import("@/lib/workspaces/queries/expenses");
const { MatterApprovalView } = await import("./matter-approval-view");
const { InvoiceComposer } = await import("./invoice-composer");

const resetServer = (entries: TimeEntry[]) => {
  server.entries = new Map(entries.map((item) => [item.id, item]));
  server.refusals = new Map();
  server.approveCalls = [];
  server.prefillReads = 0;
  server.listReads = 0;
};

afterEach(async () => {
  await testing.act(async () => {
    testing.cleanup();
  });
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

/** Keeps the composer's prefill query observed, as the open composer does. */
const PrefillObserver = () => {
  query.useQuery(invoicePrefillOptions(WORKSPACE));
  return null;
};

const ComposerFromPrefill = ({ pending }: { pending: number }) => {
  const { data } = query.useSuspenseQuery(invoicePrefillOptions(WORKSPACE));
  return (
    <InvoiceComposer
      pendingApprovalCount={pending}
      prefill={data}
      workspaceId={WORKSPACE}
    />
  );
};

const mount = async (
  role: "owner" | "member",
  page: () => ReactNode,
  seed: (client: Client) => void = () => undefined,
) => {
  const client = new query.QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(rootKeys.role, role);
  seed(client);
  const root = router.createRootRoute({ component: router.Outlet });
  const protectedRoute = router.createRoute({
    getParentRoute: () => root,
    id: "_protected",
    beforeLoad: () => ({ user: { id: USER } }),
  });
  const timesheets = router.createRoute({
    getParentRoute: () => protectedRoute,
    path: "/workspaces/$workspaceId/timesheets",
    validateSearch: (search: Record<string, unknown>) =>
      search["view"] === "approvals" ? { view: "approvals" as const } : {},
    component: page,
  });
  const appRouter = router.createRouter({
    routeTree: root.addChildren([protectedRoute.addChildren([timesheets])]),
    history: router.createMemoryHistory({
      initialEntries: [`/workspaces/${WORKSPACE}/timesheets`],
    }),
    isServer: false,
  });
  await appRouter.load();
  testing.render(
    <query.QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <router.RouterProvider router={appRouter} />
        </FormattingProvider>
      </IntlProvider>
    </query.QueryClientProvider>,
  );
  return client;
};

const approvalPage = () => (
  <>
    <PrefillObserver />
    <Suspense fallback={null}>
      <MatterApprovalView workspaceId={WORKSPACE} />
    </Suspense>
  </>
);

const rowOf = (narrative: string) => {
  const row = testing.screen.getByText(narrative).closest(".rounded-md");
  if (!(row instanceof HTMLElement)) {
    throw new Error(`No row for ${narrative}`);
  }
  return row;
};

describe("matter approval view", () => {
  test("an approver approves one entry and the invoice prefill is read again", async () => {
    resetServer([entry("entry-a"), entry("entry-b")]);
    await mount("owner", approvalPage);
    await testing.screen.findByText("Narrative entry-a");
    await testing.waitFor(() => expect(server.prefillReads).toBe(1));

    await testing.act(async () => {
      testing.fireEvent.click(
        testing.within(rowOf("Narrative entry-a")).getByRole("button", {
          name: messages.billing.approve,
        }),
      );
    });

    await testing.waitFor(() =>
      expect(server.approveCalls).toEqual([["entry-a"]]),
    );
    // The approved entry moves to the approved list, where it can be returned.
    await testing.waitFor(() =>
      expect(
        testing
          .within(rowOf("Timekeeper One: Narrative entry-a"))
          .getByRole("button", { name: messages.billing.revertToDraft }),
      ).toBeTruthy(),
    );
    await testing.waitFor(() => expect(server.prefillReads).toBe(2));
  });

  test("approving a selection sends one request with every selected entry", async () => {
    resetServer([entry("entry-a"), entry("entry-b"), entry("entry-c")]);
    await mount("owner", approvalPage);
    await testing.screen.findByText("Narrative entry-a");

    for (const narrative of ["Narrative entry-a", "Narrative entry-c"]) {
      await testing.act(async () => {
        testing.fireEvent.click(
          testing.within(rowOf(narrative)).getByRole("checkbox", {
            name: messages.billing.approval.selectEntry,
          }),
        );
      });
    }
    await testing.act(async () => {
      testing.fireEvent.click(
        testing.screen.getByRole("button", {
          name: "Approve 2 selected entries",
        }),
      );
    });

    await testing.waitFor(() =>
      expect(server.approveCalls).toEqual([["entry-a", "entry-c"]]),
    );
    await testing.waitFor(() =>
      expect(
        testing.screen.getByText("Timekeeper One: Narrative entry-c"),
      ).toBeTruthy(),
    );
    expect(server.approveCalls).toHaveLength(1);
    expect(testing.screen.getByText("Narrative entry-b")).toBeTruthy();
  });

  test("someone who cannot approve sees no approval controls", async () => {
    const draft = entry("entry-a");
    resetServer([draft]);
    // The matter's drafts are already cached, so any approval list that
    // mounts renders them at once rather than after a fetch.
    await mount("member", approvalPage, (client) => {
      client.setQueryData(
        timeEntriesOptions(WORKSPACE, USER, { status: "draft" }).queryKey,
        [{ ...draft, rateAtEntry: cents(draft.rateAtEntry) }],
      );
      client.setQueryData(
        timeEntriesOptions(WORKSPACE, USER, { status: "approved" }).queryKey,
        [],
      );
      client.setQueryData(
        expensesOptions(WORKSPACE, { status: "draft" }).queryKey,
        [],
      );
      client.setQueryData(
        expensesOptions(WORKSPACE, { status: "approved" }).queryKey,
        [],
      );
    });
    await testing.waitFor(() => expect(server.prefillReads).toBe(1));

    expect(testing.screen.queryByText("Narrative entry-a")).toBeNull();
    expect(
      testing.screen.queryByRole("button", { name: messages.billing.approve }),
    ).toBeNull();
    expect(testing.screen.queryByRole("checkbox")).toBeNull();
    expect(server.listReads).toBe(0);
  });

  test("a refused unpriced entry shows the reason on that entry only", async () => {
    resetServer([
      entry("entry-unpriced", { currency: "XXX", rateAtEntry: 0 }),
      entry("entry-priced"),
    ]);
    await mount("owner", approvalPage);
    await testing.screen.findByText("Narrative entry-unpriced");
    server.refusals.set("entry-unpriced", "unpriced");
    const unpriced = rowOf("Narrative entry-unpriced");
    expect(
      testing.within(unpriced).getByText(messages.billing.rates.noRateFound),
    ).toBeTruthy();

    for (const narrative of [
      "Narrative entry-unpriced",
      "Narrative entry-priced",
    ]) {
      await testing.act(async () => {
        testing.fireEvent.click(
          testing.within(rowOf(narrative)).getByRole("checkbox"),
        );
      });
    }
    await testing.act(async () => {
      testing.fireEvent.click(
        testing.screen.getByRole("button", {
          name: "Approve 2 selected entries",
        }),
      );
    });

    const alert = await testing.screen.findByRole("alert");
    expect(alert.textContent).toBe(messages.billing.approval.refusals.unpriced);
    expect(rowOf("Narrative entry-unpriced").contains(alert)).toBe(true);
    expect(testing.screen.getAllByRole("alert")).toHaveLength(1);
    expect(server.approveCalls).toEqual([["entry-unpriced", "entry-priced"]]);
  });
});

describe("invoice composer with nothing approved", () => {
  for (const [pending, label] of [
    [1, "1 item is awaiting approval. Review approvals."],
    [3, "3 items are awaiting approval. Review approvals."],
  ] as const) {
    test(`links to the approval queue with ${pending} pending`, async () => {
      resetServer([]);
      await mount("owner", () => (
        <Suspense fallback={null}>
          <ComposerFromPrefill pending={pending} />
        </Suspense>
      ));

      const link = await testing.screen.findByRole("link", { name: label });
      expect(link.getAttribute("href")).toBe(
        `/workspaces/${WORKSPACE}/timesheets?view=approvals`,
      );
    });
  }

  test("links to the timesheet when nothing awaits approval", async () => {
    resetServer([]);
    await mount("owner", () => (
      <Suspense fallback={null}>
        <ComposerFromPrefill pending={0} />
      </Suspense>
    ));

    const link = await testing.screen.findByRole("link", {
      name: messages.billing.timesheets,
    });
    expect(link.getAttribute("href")).toBe(
      `/workspaces/${WORKSPACE}/timesheets`,
    );
  });
});
