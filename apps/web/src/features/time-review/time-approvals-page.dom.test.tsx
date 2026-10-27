import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";

import { cents } from "@stll/money";
import { Temporal } from "@stll/time";

import messages from "@/i18n/langs/en.json";
import type { TimeApprovalItem } from "@/lib/workspaces/queries/time-approvals";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/time/approvals" });

const { act, Suspense, useState } = await import("react");
const { cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { stellaToast } = await import("@stll/ui/toast");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { TimeApprovalsPage } =
  await import("@/features/time-review/time-approvals-page");

const ORGANIZATION_ID = "organization-1";
const APPROVER_ID = "approver-1";
const MONDAY = "2026-10-26";
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

const submitted = (
  id: string,
  overrides: Partial<TimeApprovalItem> = {},
): TimeApprovalItem =>
  ({
    id,
    activityGroup: "client",
    workspaceId: "matter-lease",
    matterName: "Harbour lease",
    userId: "user-adam",
    timekeeperName: "Adam Novak",
    dateWorked: MONDAY,
    timezoneId: "UTC",
    durationMinutes: 60,
    billedMinutes: 60,
    narrative: `Narrative ${id}`,
    billable: true,
    noCharge: false,
    rateAtEntry: cents(120_000),
    currency: "CZK",
    status: "submitted",
    approverUserId: APPROVER_ID,
    approvedByUserId: null,
    approvedAt: null,
    returnedAt: null,
    returnedByUserId: null,
    returnComment: null,
    ...overrides,
  }) satisfies TimeApprovalItem;

type ApiCall = { method: string; path: string; body: unknown };

/** The approval queue, approve and return endpoints over in-memory rows. */
const serveQueue = (
  initial: TimeApprovalItem[],
  {
    pageSize = 200,
    failLaterPages = false,
  }: { pageSize?: number; failLaterPages?: boolean } = {},
) => {
  let queue = [...initial];
  const calls: ApiCall[] = [];
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json" },
    });
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const path = url.pathname.replace(/^.*\/v1/u, "");
      const text = request.method === "GET" ? "" : await request.text();
      const body: unknown = text === "" ? null : JSON.parse(text);
      calls.push({ method: request.method, path, body });
      if (request.method === "GET" && path === "/time-entries/approval-queue") {
        const from = url.searchParams.get("from") ?? "";
        const to = url.searchParams.get("to") ?? "";
        const cursor = url.searchParams.get("cursor");
        if (failLaterPages && cursor !== null) {
          return new Response("unavailable", { status: 503 });
        }
        const inRange = queue.filter(
          (item) => item.dateWorked >= from && item.dateWorked <= to,
        );
        const offset = cursor === null ? 0 : Number(cursor);
        const more = offset + pageSize < inRange.length;
        return json({
          items: inRange.slice(offset, offset + pageSize),
          nextCursor: more ? String(offset + pageSize) : null,
          limit: pageSize,
          pendingCount: inRange.length,
        });
      }
      if (request.method === "POST" && path === "/time-entries/approve") {
        const ids = (body as { ids: string[] }).ids;
        queue = queue.filter((item) => !ids.includes(item.id));
        return json({
          results: ids.map((id) => ({ id, status: "approved" })),
        });
      }
      if (
        request.method === "POST" &&
        path === "/time-entries/approval-queue/return"
      ) {
        const { id } = body as { id: string };
        queue = queue.filter((item) => item.id !== id);
        return json({ id, status: "draft" });
      }
      return new Response(JSON.stringify({ code: "not_found" }), {
        status: 404,
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  return calls;
};

const Harness = () => {
  const [filter, setFilter] = useState({
    date: MONDAY,
    member: undefined as string | undefined,
    matter: undefined as string | undefined,
  });
  return (
    <TimeApprovalsPage
      filter={filter}
      onFilterChange={setFilter}
      onThisWeek={() => setFilter({ ...filter, date: MONDAY })}
      organizationId={ORGANIZATION_ID}
      userId={APPROVER_ID}
    />
  );
};

const mount = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en-GB" timeZone="UTC">
          <Suspense fallback={null}>
            <Harness />
          </Suspense>
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
};

const personSection = async (name: string) =>
  await screen.findByRole("region", { name });

describe("approving time by person", () => {
  test("groups the week's submitted time by person with their totals", async () => {
    serveQueue([
      submitted("adam-1"),
      submitted("adam-2", {
        dateWorked: Temporal.PlainDate.from(MONDAY).add({ days: 1 }).toString(),
        billedMinutes: 30,
      }),
      submitted("beata-1", {
        userId: "user-beata",
        timekeeperName: "Beata Kral",
      }),
    ]);
    mount();

    const adam = await personSection("Adam Novak");
    expect(within(adam).getByText(/1 hr 30 min billed/u)).toBeTruthy();
    expect(within(adam).getAllByRole("listitem")).toHaveLength(2);
    expect(
      within(await personSection("Beata Kral")).getAllByRole("listitem"),
    ).toHaveLength(1);
  });

  test("approving one person's week sends only their entries and clears them", async () => {
    const calls = serveQueue([
      submitted("adam-1"),
      submitted("adam-2"),
      submitted("beata-1", {
        userId: "user-beata",
        timekeeperName: "Beata Kral",
      }),
    ]);
    mount();

    const adam = await personSection("Adam Novak");
    await act(async () => {
      fireEvent.click(
        within(adam).getByRole("button", { name: "Approve all 2 entries" }),
      );
    });

    await waitFor(() => {
      expect(
        screen.queryByRole("region", { name: "Adam Novak" }) === null,
      ).toBe(true);
    });
    const approval = calls.find(({ path }) => path === "/time-entries/approve");
    expect(approval?.body).toEqual({ ids: ["adam-1", "adam-2"] });
    expect(await personSection("Beata Kral")).toBeTruthy();
  });

  test("checking entries narrows a person's approval to them", async () => {
    const calls = serveQueue([submitted("adam-1"), submitted("adam-2")]);
    mount();

    const adam = await personSection("Adam Novak");
    const [first] = within(adam).getAllByRole("checkbox", {
      name: messages.billing.approval.selectEntry,
    });
    if (!first) {
      throw new Error("expected a selection checkbox");
    }
    await act(async () => {
      fireEvent.click(first);
    });
    await act(async () => {
      fireEvent.click(
        within(adam).getByRole("button", { name: "Approve 1 selected entry" }),
      );
    });

    await waitFor(() => {
      expect(
        calls.find(({ path }) => path === "/time-entries/approve")?.body,
      ).toEqual({ ids: ["adam-1"] });
    });
    // The unchecked entry is still waiting.
    expect(
      await within(await personSection("Adam Novak")).findByRole("button", {
        name: "Approve 1 entry",
      }),
    ).toBeTruthy();
  });

  test("returning an entry sends the reason and takes it off the page", async () => {
    const calls = serveQueue([submitted("adam-1"), submitted("adam-2")]);
    mount();

    const row = (await screen.findByText("Narrative adam-1")).closest("li");
    if (!(row instanceof HTMLElement)) {
      throw new Error("no row for adam-1");
    }
    const send = within(row).getByRole("button", {
      name: messages.billing.revertToDraft,
    });
    expect(send).toHaveProperty("disabled", true);
    await act(async () => {
      fireEvent.change(
        within(row).getByRole("textbox", {
          name: messages.billing.approval.returnComment,
        }),
        { target: { value: "  Split the call from the drafting " } },
      );
    });
    await act(async () => {
      fireEvent.click(send);
    });

    await waitFor(() => {
      expect(screen.queryByText("Narrative adam-1") === null).toBe(true);
    });
    expect(
      calls.find(({ path }) => path === "/time-entries/approval-queue/return")
        ?.body,
    ).toEqual({ id: "adam-1", comment: "Split the call from the drafting" });
    expect(screen.getByText("Narrative adam-2")).toBeTruthy();
  });

  test("a later page that fails to load says so and keeps the loaded entries", async () => {
    serveQueue([submitted("adam-1"), submitted("adam-2")], {
      pageSize: 1,
      failLaterPages: true,
    });
    const toasts = spyOn(stellaToast, "add");
    try {
      mount();

      expect(await personSection("Adam Novak")).toBeTruthy();
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: messages.common.loadMore }),
        );
      });

      await waitFor(() => {
        expect(toasts).toHaveBeenCalled();
      });
      expect(await personSection("Adam Novak")).toBeTruthy();
    } finally {
      toasts.mockRestore();
    }
  });

  test("an empty week says where submitted time will appear", async () => {
    serveQueue([]);
    mount();
    expect(
      await screen.findByText(messages.billing.approval.emptyWeek),
    ).toBeTruthy();
  });
});
