import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";
import * as v from "valibot";

import { cents } from "@stll/money";

import messages from "@/i18n/langs/en.json";
import type {
  ClientInvoicePrefill,
  InvoicePrefill,
} from "@/lib/workspaces/queries/invoices";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/contacts/client" });

const { act } = await import("react");
const { cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { createRootRoute, createRouter, createMemoryHistory, RouterProvider } =
  await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { formatCurrencyAmount } =
  await import("@/components/billing/format-currency");
const { toSafeId } = await import("@/lib/safe-id");

const CLIENT_ID = toSafeId<"contact">("00000000-0000-4000-8000-000000000001");
const FIRST_MATTER_ID = toSafeId<"workspace">(
  "00000000-0000-4000-8000-000000000002",
);
const LATER_MATTER_ID = toSafeId<"workspace">(
  "00000000-0000-4000-8000-000000000003",
);
const FIRST_ENTRY_ID = toSafeId<"timeEntry">(
  "00000000-0000-4000-8000-000000000004",
);
const LATER_ENTRY_ID = toSafeId<"timeEntry">(
  "00000000-0000-4000-8000-000000000005",
);
const INVOICE_ID = toSafeId<"invoice">("00000000-0000-4000-8000-000000000006");
const FIRST_NAME = "Earlier matter";
const LATER_NAME = "Later matter";

const prefill = ({
  entryId,
  dateWorked,
  vatRateBps,
  currency = "EUR",
  billedMinutes = 60,
}: {
  entryId: typeof FIRST_ENTRY_ID;
  dateWorked: string;
  vatRateBps: number;
  currency?: string;
  billedMinutes?: number;
}) =>
  ({
    currency,
    language: "sk",
    invoiceDate: "2025-02-01",
    taxableSupplyDate: dateWorked,
    dueDays: 14,
    dueDaysSource: "default",
    seller: {
      id: toSafeId<"sellerProfile">("00000000-0000-4000-8000-000000000007"),
      legalName: "Invoice seller",
      vatId: "SK1234567890",
      vatPayer: true,
      defaultCurrency: "EUR",
    },
    sellerSource: "default",
    buyer: {
      buyerName: "Invoice client",
      buyerRegistrationId: null,
      buyerTaxId: null,
      buyerVatId: null,
      buyerAddressLine1: null,
      buyerAddressLine2: null,
      buyerCity: null,
      buyerPostalCode: null,
      buyerCountry: "SK",
    },
    buyerSource: "client",
    vat: { vatTreatment: "domestic_vat", vatRateBps, reason: "domestic_rate" },
    vatRatePeriods: [
      {
        validFrom: "2011-01-01",
        validTo: "2025-01-01",
        rateBps: 2000,
      },
      {
        validFrom: "2025-01-01",
        validTo: null,
        rateBps: 2300,
      },
    ],
    billingMode: "hourly",
    flatFeeAmount: null,
    timeEntries: [
      {
        id: entryId,
        userId: null,
        dateWorked,
        durationMinutes: billedMinutes,
        billedMinutes,
        rateAtEntry: cents(10_000),
        currency,
        narrative: "Legal services",
        invoiceNarrative: null,
        noCharge: false,
        taskCode: null,
        activityCode: null,
        timekeeperName: null,
      },
    ],
    expenses: [],
  }) satisfies InvoicePrefill;

const data = {
  clientId: CLIENT_ID,
  matters: [
    {
      workspaceId: FIRST_MATTER_ID,
      name: FIRST_NAME,
      color: null,
      prefill: prefill({
        entryId: FIRST_ENTRY_ID,
        dateWorked: "2024-12-31",
        vatRateBps: 2000,
      }),
    },
    {
      workspaceId: LATER_MATTER_ID,
      name: LATER_NAME,
      color: null,
      prefill: prefill({
        entryId: LATER_ENTRY_ID,
        dateWorked: "2025-01-01",
        vatRateBps: 2300,
      }),
    },
  ],
} satisfies ClientInvoicePrefill;

// The euro matter holds more unbilled work, so euros are the default.
const mixedCurrencyData = {
  clientId: CLIENT_ID,
  matters: [
    {
      workspaceId: FIRST_MATTER_ID,
      name: FIRST_NAME,
      color: null,
      prefill: prefill({
        entryId: FIRST_ENTRY_ID,
        dateWorked: "2025-01-01",
        vatRateBps: 2300,
        billedMinutes: 120,
      }),
    },
    {
      workspaceId: LATER_MATTER_ID,
      name: LATER_NAME,
      color: null,
      prefill: prefill({
        entryId: LATER_ENTRY_ID,
        dateWorked: "2025-01-01",
        vatRateBps: 2300,
        currency: "CZK",
      }),
    },
  ],
} satisfies ClientInvoicePrefill;

// The euro work after its invoice was saved: the prefill no longer offers it.
const euroBilledData = {
  ...mixedCurrencyData,
  matters: mixedCurrencyData.matters.map((matter) =>
    matter.workspaceId === FIRST_MATTER_ID
      ? { ...matter, prefill: { ...matter.prefill, timeEntries: [] } }
      : matter,
  ),
} satisfies ClientInvoicePrefill;

let served: ClientInvoicePrefill = data;
/** What the prefill serves once an invoice is saved; null keeps it as is. */
let servedAfterSave: ClientInvoicePrefill | null = null;
let prefillReads = 0;
const originalFetch = globalThis.fetch;
const requests: Record<string, unknown>[] = [];
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (
      request.method === "GET" &&
      path.endsWith(`/client-invoices/${CLIENT_ID}/prefill`)
    ) {
      prefillReads += 1;
      return Response.json(served);
    }
    if (
      request.method === "PUT" &&
      path.endsWith(`/client-invoices/${CLIENT_ID}`)
    ) {
      const body = v.parse(
        v.record(v.string(), v.unknown()),
        await request.json(),
      );
      requests.push(body);
      served = servedAfterSave ?? served;
      return Response.json({
        id: INVOICE_ID,
        invoiceNumber: null,
        totalAmount: body["expectedTotalAmount"],
        workspaceId: FIRST_MATTER_ID,
      });
    }
    if (request.method === "GET" && path.endsWith(`/${INVOICE_ID}`)) {
      return Response.json({
        id: INVOICE_ID,
        status: "draft",
        invoiceNumber: null,
        totalAmount: requests.at(-1)?.["expectedTotalAmount"],
        currency: requests.at(-1)?.["currency"],
        dueDate: "2025-02-15",
      });
    }
    return panic("Unexpected client invoice fixture request", {
      method: request.method,
      path,
    });
  },
  { preconnect: () => undefined },
);

const { ClientInvoiceComposer } = await import("./client-invoice-composer");

const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(async () => {
  await act(async () => cleanup());
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  requests.length = 0;
  served = data;
  servedAfterSave = null;
  prefillReads = 0;
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const mount = async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const root = createRootRoute({
    component: () => (
      <ClientInvoiceComposer
        clientId={CLIENT_ID}
        clientName="Invoice client"
        open
        onOpenChange={() => undefined}
      />
    ),
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
    isServer: false,
  });
  await router.load();
  render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <RouterProvider router={router} />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
};

const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
};

const expectSubtotal = (name: string, amount: number) => {
  const section =
    screen.getByRole("heading", { name }).closest("section") ??
    panic("Missing matter section");
  expect(
    within(section).getByText(formatCurrencyAmount(amount, "EUR"), {
      exact: true,
    }),
  ).toBeDefined();
};

const expectRowNetAmount = (name: string, amount: number) => {
  const section =
    screen.getByRole("heading", { name }).closest("section") ??
    panic("Missing matter section");
  const table = within(section).getByRole("table");
  const amountHeader = within(table).getByRole("columnheader", {
    name: messages.billing.amount,
  });
  const amountColumn = within(table)
    .getAllByRole("columnheader")
    .indexOf(amountHeader);
  const row =
    within(table).getByText("Legal services").closest("tr") ??
    panic("Missing entry row");
  const amountCell =
    within(row).getAllByRole("cell").at(amountColumn) ??
    panic("Missing entry amount cell");
  expect(amountCell.textContent).toBe(formatCurrencyAmount(amount, "EUR"));
};

test.each([
  {
    excludeLater: false,
    supplyDate: "2025-01-01",
    dateLabel: "Jan 1, 2025",
    total: 24_600,
  },
  {
    excludeLater: true,
    supplyDate: "2024-12-31",
    dateLabel: "Dec 31, 2024",
    total: 12_000,
  },
])(
  "combined selected work determines supply date and VAT: excludeLater=$excludeLater",
  async ({ excludeLater, supplyDate, dateLabel, total }) => {
    await mount();
    await screen.findByRole("heading", { name: LATER_NAME });
    // Even the earlier matter uses the combined supply date's rate.
    expectSubtotal(FIRST_NAME, 12_300);
    expectSubtotal(LATER_NAME, 12_300);
    expectRowNetAmount(FIRST_NAME, 10_000);
    expectRowNetAmount(LATER_NAME, 10_000);
    if (excludeLater) {
      await act(async () => {
        fireEvent.click(
          screen.getByRole("checkbox", {
            name: messages.billing.clientComposer.includeMatter.replace(
              "{matterName}",
              () => LATER_NAME,
            ),
          }),
        );
      });
      expectSubtotal(FIRST_NAME, 12_000);
      expectSubtotal(LATER_NAME, 0);
    }
    // Entry rows show recorded net amounts, including an excluded row.
    expectRowNetAmount(FIRST_NAME, 10_000);
    expectRowNetAmount(LATER_NAME, 10_000);
    await click(messages.billing.invoiceComposer.continueToDetails);
    expect(screen.getByText(dateLabel)).toBeDefined();
    await click(messages.billing.invoiceComposer.continueToIssue);
    await click(messages.billing.invoiceComposer.saveDraft);
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests.at(0)).toMatchObject({
      taxableSupplyDate: supplyDate,
      expectedTotalAmount: total,
      matters: excludeLater
        ? [
            {
              workspaceId: FIRST_MATTER_ID,
              timeEntryIds: [FIRST_ENTRY_ID],
              expenseIds: [],
            },
          ]
        : [
            {
              workspaceId: FIRST_MATTER_ID,
              timeEntryIds: [FIRST_ENTRY_ID],
              expenseIds: [],
            },
            {
              workspaceId: LATER_MATTER_ID,
              timeEntryIds: [LATER_ENTRY_ID],
              expenseIds: [],
            },
          ],
    });
    await screen.findByRole("heading", {
      name: messages.billing.invoiceComposer.draftSavedTitle,
    });
  },
);

test("work in two currencies bills only the chosen currency's matters", async () => {
  served = mixedCurrencyData;
  await mount();
  const currency = await screen.findByRole("combobox", {
    name: messages.common.currency,
  });
  // Euros hold more unbilled work, so the composer opens on them.
  expect(currency.textContent).toBe("EUR");
  expect(screen.getByRole("heading", { name: FIRST_NAME })).toBeDefined();
  expect(screen.queryByRole("heading", { name: LATER_NAME })).toBeNull();
  await act(async () => {
    fireEvent.mouseDown(currency, { button: 0 });
  });
  const czk = await screen.findByRole("option", { name: "CZK" });
  await act(async () => {
    fireEvent.pointerDown(czk, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(czk, { button: 0, pointerType: "mouse" });
    fireEvent.click(czk, { button: 0, detail: 1 });
  });
  await screen.findByRole("heading", { name: LATER_NAME });
  expect(screen.queryByRole("heading", { name: FIRST_NAME })).toBeNull();
  await click(messages.billing.invoiceComposer.continueToDetails);
  await click(messages.billing.invoiceComposer.continueToIssue);
  await click(messages.billing.invoiceComposer.saveDraft);
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests.at(0)).toMatchObject({
    currency: "CZK",
    // One hour at 100.00 plus 23 % VAT.
    expectedTotalAmount: 12_300,
  });
  expect(requests.at(0)?.["matters"]).toEqual([
    {
      workspaceId: LATER_MATTER_ID,
      timeEntryIds: [LATER_ENTRY_ID],
      expenseIds: [],
    },
  ]);
  await screen.findByRole("heading", {
    name: messages.billing.invoiceComposer.draftSavedTitle,
  });
});

test("a saved invoice's work is no longer offered by the client's prefill", async () => {
  served = mixedCurrencyData;
  servedAfterSave = euroBilledData;
  await mount();
  const currency = await screen.findByRole("combobox", {
    name: messages.common.currency,
  });
  expect(currency.textContent).toBe("EUR");
  expect(screen.getByRole("heading", { name: FIRST_NAME })).toBeDefined();
  expect(prefillReads).toBe(1);
  await click(messages.billing.invoiceComposer.continueToDetails);
  await click(messages.billing.invoiceComposer.continueToIssue);
  await click(messages.billing.invoiceComposer.saveDraft);
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests.at(0)).toMatchObject({ currency: "EUR" });
  // Saving invalidates the client's prefill, which no longer offers the
  // billed euro work: only koruna work remains, so no currency is left to
  // choose and the euro matter is gone.
  await waitFor(() => expect(prefillReads).toBe(2));
  await screen.findByRole("heading", { name: LATER_NAME });
  expect(screen.queryByRole("heading", { name: FIRST_NAME })).toBeNull();
  expect(
    screen.queryByRole("combobox", { name: messages.common.currency }),
  ).toBeNull();
});
