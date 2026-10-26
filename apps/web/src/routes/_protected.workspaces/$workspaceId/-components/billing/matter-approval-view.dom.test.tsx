import { Suspense } from "react";
import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { QueryClient as Client } from "@tanstack/react-query";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";

import type { TimeApprovalRefusal } from "@stll/api-contract/time-entries";
import type { TimeEntry } from "@stll/api-contract/time-entry-types";
import { cents } from "@stll/money";

import { toSafeId } from "@/lib/safe-id";
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

/** One row of the expense list, as the web client reads it from the API. */
type Expense = Awaited<
  ReturnType<NonNullable<ReturnType<typeof expensesOptions>["queryFn"]>>
>[number];

const expense = (id: string, overrides: Partial<Expense> = {}): Expense =>
  ({
    id: toSafeId<"expense">(id),
    userId: "timekeeper-1",
    matterId: null,
    matterReference: null,
    dateIncurred: "2026-10-08",
    amount: cents(4500),
    currency: "CZK",
    category: "filing_fee",
    description: `Expense ${id}`,
    invoiceDescription: null,
    billable: true,
    markup: 0,
    status: "draft",
    userName: "Timekeeper One",
    createdAt: "2026-10-08T10:00:00Z",
    updatedAt: null,
    ...overrides,
  }) satisfies Expense;

type Server = {
  entries: Map<string, TimeEntry>;
  expenses: Map<string, Expense>;
  /** Time entries the API refuses to approve or return, with the reason. */
  refusals: Map<string, TimeApprovalRefusal>;
  /** Expenses the API refuses to change, as it does once one is billed. */
  expenseRefusals: Set<string>;
  approveCalls: string[][];
  returnCalls: unknown[];
  expenseCalls: unknown[];
  /**
   * While set, each return or expense change is recorded and then waits for
   * the test to release it, so several can be in flight at once.
   */
  holdWrites: boolean;
  /** One release per held request, in arrival order. */
  held: (() => void)[];
  prefillReads: number;
  listReads: number;
};
const server: Server = {
  entries: new Map(),
  expenses: new Map(),
  refusals: new Map(),
  expenseRefusals: new Set(),
  approveCalls: [],
  returnCalls: [],
  expenseCalls: [],
  holdWrites: false,
  held: [],
  prefillReads: 0,
  listReads: 0,
};

const holdIfAsked = async () => {
  if (server.holdWrites) {
    await new Promise<void>((resolve) => {
      server.held.push(resolve);
    });
  }
};

// The API's own shapes: a list page, a per-entry approval outcome, a returned
// entry, an updated expense, its error bodies, and the invoice prefill of a
// matter whose time is all still in draft.
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
    if (
      request.method === "POST" &&
      url.pathname.endsWith("/approval-queue/return")
    ) {
      const body: unknown = await request.json();
      server.returnCalls.push(body);
      const { id } = v.parse(v.object({ id: v.string() }), body);
      await holdIfAsked();
      const reason = server.refusals.get(id);
      if (reason) {
        return Response.json(
          {
            code: reason,
            message: "Time entry cannot be returned",
            hint: "Check the assigned approver, entry status, running timer, and locked period.",
          },
          { status: 409 },
        );
      }
      const current = server.entries.get(id);
      if (current) {
        server.entries.set(id, { ...current, status: "draft" });
      }
      return Response.json({ id, status: "draft" });
    }
    if (
      request.method === "PATCH" &&
      url.pathname.endsWith(`/expenses/${WORKSPACE}`)
    ) {
      const body: unknown = await request.json();
      server.expenseCalls.push(body);
      const { id, status } = v.parse(
        v.object({ id: v.string(), status: v.picklist(["draft", "approved"]) }),
        body,
      );
      await holdIfAsked();
      if (server.expenseRefusals.has(id)) {
        return Response.json(
          { message: "Cannot edit a billed or written-off expense" },
          { status: 400 },
        );
      }
      const current = server.expenses.get(id);
      if (current) {
        server.expenses.set(id, { ...current, status });
      }
      return Response.json({ id });
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
      const status = url.searchParams.get("status");
      return Response.json({
        items: [...server.expenses.values()].filter(
          (item) => item.status === status,
        ),
        limit: 100,
        nextCursor: null,
      });
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

const resetServer = (entries: TimeEntry[], expenses: Expense[] = []) => {
  server.entries = new Map(entries.map((item) => [item.id, item]));
  server.expenses = new Map(expenses.map((item) => [item.id, item]));
  server.refusals = new Map();
  server.expenseRefusals = new Set();
  server.approveCalls = [];
  server.returnCalls = [];
  server.expenseCalls = [];
  server.holdWrites = false;
  server.held = [];
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

const typeReturnComment = async (row: HTMLElement, comment: string) => {
  await testing.act(async () => {
    testing.fireEvent.change(
      testing.within(row).getByRole("textbox", {
        name: messages.billing.approval.returnComment,
      }),
      { target: { value: comment } },
    );
  });
};

const clickIn = async (row: HTMLElement, name: string) => {
  await testing.act(async () => {
    testing.fireEvent.click(testing.within(row).getByRole("button", { name }));
  });
};

/** Lets the `index`th held request reach its handler and answer. */
const releaseHeld = async (index: number) => {
  const release = server.held[index];
  if (!release) {
    throw new Error(`No held request at ${index}`);
  }
  await testing.act(async () => {
    release();
  });
};

describe("returning approved time to draft", () => {
  test("sends the trimmed comment, moves the entry back to draft and reads the invoice prefill again", async () => {
    resetServer([entry("entry-a", { status: "approved" })]);
    await mount("owner", approvalPage);
    await testing.screen.findByText("Timekeeper One: Narrative entry-a");
    await testing.waitFor(() => expect(server.prefillReads).toBe(1));
    const row = rowOf("Timekeeper One: Narrative entry-a");
    const revert = testing.within(row).getByRole("button", {
      name: messages.billing.revertToDraft,
    });
    // A blank comment cannot be sent: the API requires a reason.
    expect(revert).toHaveProperty("disabled", true);
    await typeReturnComment(row, "   ");
    expect(revert).toHaveProperty("disabled", true);

    const comment = "Add the client meeting to the narrative";
    await typeReturnComment(row, `  ${comment}\n`);
    await clickIn(row, messages.billing.revertToDraft);

    await testing.waitFor(() =>
      expect(server.returnCalls).toEqual([{ id: "entry-a", comment }]),
    );
    // Back among the drafts, where it can be approved again.
    await testing.waitFor(() =>
      expect(
        testing
          .within(rowOf("Narrative entry-a"))
          .getByRole("button", { name: messages.billing.approve }),
      ).toBeTruthy(),
    );
    await testing.waitFor(() => expect(server.prefillReads).toBe(2));
    expect(testing.screen.queryByRole("alert")).toBeNull();
  });

  test("a refused return shows the reason on that entry only", async () => {
    resetServer([
      entry("entry-locked", { status: "approved" }),
      entry("entry-open", { status: "approved" }),
    ]);
    await mount("owner", approvalPage);
    await testing.screen.findByText("Timekeeper One: Narrative entry-locked");
    await testing.waitFor(() => expect(server.prefillReads).toBe(1));
    server.refusals.set("entry-locked", "time_period_locked");
    const locked = rowOf("Timekeeper One: Narrative entry-locked");

    await typeReturnComment(locked, "Wrong matter");
    await clickIn(locked, messages.billing.revertToDraft);

    const alert = await testing.screen.findByRole("alert");
    expect(alert.textContent).toBe(messages.billing.globalTimer.periodLocked);
    expect(
      rowOf("Timekeeper One: Narrative entry-locked").contains(alert),
    ).toBe(true);
    expect(testing.screen.getAllByRole("alert")).toHaveLength(1);
    expect(server.returnCalls).toEqual([
      { id: "entry-locked", comment: "Wrong matter" },
    ]);
    // Still approved, and nothing billable changed.
    expect(
      testing
        .within(rowOf("Timekeeper One: Narrative entry-locked"))
        .getByRole("button", { name: messages.billing.revertToDraft }),
    ).toBeTruthy();
    expect(testing.screen.queryByText("Narrative entry-locked")).toBeNull();
    expect(server.prefillReads).toBe(1);
  });

  test("two returns in flight each settle on their own outcome", async () => {
    resetServer([
      entry("entry-locked", { status: "approved" }),
      entry("entry-open", { status: "approved" }),
    ]);
    await mount("owner", approvalPage);
    await testing.screen.findByText("Timekeeper One: Narrative entry-locked");
    server.refusals.set("entry-locked", "time_period_locked");
    server.holdWrites = true;

    for (const [narrative, comment] of [
      ["Timekeeper One: Narrative entry-locked", "Wrong matter"],
      ["Timekeeper One: Narrative entry-open", "Wrong date"],
    ] as const) {
      await typeReturnComment(rowOf(narrative), comment);
      await clickIn(rowOf(narrative), messages.billing.revertToDraft);
    }
    // Both requests are in flight before either answers.
    await testing.waitFor(() => expect(server.held).toHaveLength(2));
    expect(server.returnCalls).toEqual([
      { id: "entry-locked", comment: "Wrong matter" },
      { id: "entry-open", comment: "Wrong date" },
    ]);

    await releaseHeld(0);
    const alert = await testing.screen.findByRole("alert");
    expect(alert.textContent).toBe(messages.billing.globalTimer.periodLocked);
    await releaseHeld(1);
    await testing.waitFor(() =>
      expect(
        testing
          .within(rowOf("Narrative entry-open"))
          .getByRole("button", { name: messages.billing.approve }),
      ).toBeTruthy(),
    );

    expect(
      rowOf("Timekeeper One: Narrative entry-locked").contains(alert),
    ).toBe(true);
    expect(testing.screen.getAllByRole("alert")).toHaveLength(1);
    expect(
      testing.within(rowOf("Narrative entry-open")).queryByRole("alert"),
    ).toBeNull();
  });
});

describe("expense approval", () => {
  for (const { from, to, action, next } of [
    {
      from: "draft",
      to: "approved",
      action: messages.billing.approve,
      next: messages.billing.revertToDraft,
    },
    {
      from: "approved",
      to: "draft",
      action: messages.billing.revertToDraft,
      next: messages.billing.approve,
    },
  ] as const) {
    test(`moving an expense from ${from} to ${to} sends that status and reads the invoice prefill again`, async () => {
      resetServer(
        [],
        [
          expense("expense-a", { status: from }),
          expense("expense-b", { status: from }),
        ],
      );
      await mount("owner", approvalPage);
      await testing.screen.findByText("Timekeeper One: Expense expense-a");
      await testing.waitFor(() => expect(server.prefillReads).toBe(1));

      await clickIn(rowOf("Timekeeper One: Expense expense-a"), action);

      await testing.waitFor(() =>
        expect(server.expenseCalls).toEqual([{ id: "expense-a", status: to }]),
      );
      await testing.waitFor(() =>
        expect(
          testing
            .within(rowOf("Timekeeper One: Expense expense-a"))
            .getByRole("button", { name: next }),
        ).toBeTruthy(),
      );
      await testing.waitFor(() => expect(server.prefillReads).toBe(2));
      // The other expense is untouched.
      expect(
        testing
          .within(rowOf("Timekeeper One: Expense expense-b"))
          .getByRole("button", { name: action }),
      ).toBeTruthy();
      expect(testing.screen.queryByRole("alert")).toBeNull();
    });
  }

  test("a refused expense shows the failure on that expense only", async () => {
    resetServer([], [expense("expense-billed"), expense("expense-open")]);
    await mount("owner", approvalPage);
    await testing.screen.findByText("Timekeeper One: Expense expense-billed");
    await testing.waitFor(() => expect(server.prefillReads).toBe(1));
    server.expenseRefusals.add("expense-billed");

    await clickIn(
      rowOf("Timekeeper One: Expense expense-billed"),
      messages.billing.approve,
    );

    const alert = await testing.screen.findByRole("alert");
    expect(alert.textContent).toBe(messages.billing.approval.failed);
    expect(
      rowOf("Timekeeper One: Expense expense-billed").contains(alert),
    ).toBe(true);
    expect(testing.screen.getAllByRole("alert")).toHaveLength(1);
    expect(server.expenseCalls).toEqual([
      { id: "expense-billed", status: "approved" },
    ]);
    expect(
      testing
        .within(rowOf("Timekeeper One: Expense expense-billed"))
        .getByRole("button", { name: messages.billing.approve }),
    ).toBeTruthy();
    expect(server.prefillReads).toBe(1);
  });

  test("two expense changes in flight each settle on their own outcome", async () => {
    resetServer([], [expense("expense-billed"), expense("expense-open")]);
    await mount("owner", approvalPage);
    await testing.screen.findByText("Timekeeper One: Expense expense-billed");
    server.expenseRefusals.add("expense-billed");
    server.holdWrites = true;

    for (const description of [
      "Timekeeper One: Expense expense-billed",
      "Timekeeper One: Expense expense-open",
    ]) {
      await clickIn(rowOf(description), messages.billing.approve);
    }
    // Both requests are in flight before either answers.
    await testing.waitFor(() => expect(server.held).toHaveLength(2));
    expect(server.expenseCalls).toEqual([
      { id: "expense-billed", status: "approved" },
      { id: "expense-open", status: "approved" },
    ]);

    await releaseHeld(0);
    const alert = await testing.screen.findByRole("alert");
    expect(alert.textContent).toBe(messages.billing.approval.failed);
    await releaseHeld(1);
    await testing.waitFor(() =>
      expect(
        testing
          .within(rowOf("Timekeeper One: Expense expense-open"))
          .getByRole("button", { name: messages.billing.revertToDraft }),
      ).toBeTruthy(),
    );

    expect(
      rowOf("Timekeeper One: Expense expense-billed").contains(alert),
    ).toBe(true);
    expect(testing.screen.getAllByRole("alert")).toHaveLength(1);
    expect(
      testing
        .within(rowOf("Timekeeper One: Expense expense-open"))
        .queryByRole("alert"),
    ).toBeNull();
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
