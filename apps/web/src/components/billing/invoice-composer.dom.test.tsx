import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import { INVOICE_ISSUE_BLOCKER } from "@stll/api-contract/billing";
import type { InvoiceIssueBlocker } from "@stll/api-contract/billing";
import { cents } from "@stll/money";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/en.json";
import type { InvoicePrefill } from "@/lib/workspaces/queries/invoices";

GlobalRegistrator.register({ url: "http://localhost:3000/invoices/new" });

const { act } = await import("react");
const { cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { createRootRoute, createRouter, createMemoryHistory, RouterProvider } =
  await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { ToastProvider, stellaToast } = await import("@stll/ui/toast");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { resetUserErrorReportDedupeForTests } =
  await import("@/lib/errors/user-toast");
const { toSafeId } = await import("@/lib/safe-id");

const WORKSPACE_ID = toSafeId<"workspace">(
  "00000000-0000-4000-8000-000000000021",
);
const ENTRY_ID = toSafeId<"timeEntry">("00000000-0000-4000-8000-000000000022");
const INVOICE_ID = toSafeId<"invoice">("00000000-0000-4000-8000-000000000023");

const prefill = (issueBlockers: InvoiceIssueBlocker[]) =>
  ({
    currency: "EUR",
    language: "en",
    invoiceDate: "2026-10-30",
    taxableSupplyDate: "2026-10-28",
    dueDays: 14,
    dueDaysSource: "default",
    seller: {
      id: toSafeId<"sellerProfile">("00000000-0000-4000-8000-000000000024"),
      legalName: "Harbour Legal",
      vatId: null,
      vatPayer: false,
      defaultCurrency: "EUR",
    },
    sellerSource: "default",
    issueBlockers,
    buyer: {
      buyerName: "Northwind Shipping",
      buyerRegistrationId: null,
      buyerTaxId: null,
      buyerVatId: null,
      buyerAddressLine1: null,
      buyerAddressLine2: null,
      buyerCity: null,
      buyerPostalCode: null,
      buyerCountry: "DE",
    },
    buyerSource: "client",
    vat: {
      vatTreatment: "not_vat_payer",
      vatRateBps: 0,
      reason: "seller_not_vat_payer",
    },
    vatRatePeriods: [],
    billingMode: "hourly",
    flatFeeAmount: null,
    timeEntries: [
      {
        id: ENTRY_ID,
        userId: null,
        dateWorked: "2026-10-28",
        durationMinutes: 60,
        billedMinutes: 60,
        rateAtEntry: cents(20_000),
        currency: "EUR",
        narrative: "Review of the charter party",
        invoiceNarrative: null,
        noCharge: false,
        taskCode: null,
        activityCode: null,
        timekeeperName: null,
      },
    ],
    expenses: [],
  }) satisfies InvoicePrefill;

/** What the issue request answers; the draft save always succeeds. */
let transitionAnswer: Response = Response.json({ id: INVOICE_ID });
const requests: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    if (
      request.method === "PUT" &&
      path.endsWith(`/invoices/${WORKSPACE_ID}`)
    ) {
      return Response.json({ id: INVOICE_ID, totalAmount: 20_000 });
    }
    if (
      request.method === "POST" &&
      path.endsWith(`/invoices/${WORKSPACE_ID}/${INVOICE_ID}/transition`)
    ) {
      return transitionAnswer;
    }
    return panic("Unexpected invoice composer request", {
      method: request.method,
      path,
    });
  },
  { preconnect: () => undefined },
);

const { InvoiceComposer } = await import("./invoice-composer");

const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(async () => {
  await act(async () => {
    stellaToast.dismiss();
    cleanup();
  });
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  requests.length = 0;
  resetUserErrorReportDedupeForTests();
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const mountAtIssueStep = async (issueBlockers: InvoiceIssueBlocker[]) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const root = createRootRoute({
    component: () => (
      <InvoiceComposer
        pendingApprovalCount={0}
        prefill={prefill(issueBlockers)}
        workspaceId={WORKSPACE_ID}
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
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  await click(messages.billing.invoiceComposer.continueToDetails);
  await click(messages.billing.invoiceComposer.continueToIssue);
};

const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(await screen.findByRole("button", { name }));
  });
};

const button = (name: string) =>
  screen.getByRole<HTMLButtonElement>("button", { name });

const toastText = (slot: "title" | "description") =>
  [...document.querySelectorAll(`[data-slot="toast-${slot}"]`)].map(
    (node) => node.textContent,
  );

test("without a number series the review step is not ready and names where to set one up", async () => {
  await mountAtIssueStep([INVOICE_ISSUE_BLOCKER.numberSeriesMissing]);

  expect(
    screen.getByText(messages.billing.invoiceComposer.notReadyTitle),
  ).toBeDefined();
  expect(
    screen.queryByText(messages.billing.invoiceComposer.readyTitle),
  ).toBeNull();
  expect(
    screen.getByText(messages.errors.apiCodes.invoiceNumberSeriesMissing),
  ).toBeDefined();
  expect(
    screen
      .getByRole("link", { name: messages.billing.numberSeries.title })
      .getAttribute("href"),
  ).toBe("/admin/number-series");
  expect(
    button(messages.billing.invoiceComposer.issueInvoice).disabled,
  ).toBeTrue();
  // The work is not lost: a draft still saves.
  expect(button(messages.billing.invoiceComposer.saveDraft).disabled).toBe(
    false,
  );
  expect(requests).toEqual([]);
});

test("without a seller the review step links to the billing profiles", async () => {
  await mountAtIssueStep([INVOICE_ISSUE_BLOCKER.sellerProfileMissing]);

  expect(
    screen.getByText(messages.errors.apiCodes.invoiceSellerProfileMissing),
  ).toBeDefined();
  expect(
    screen
      .getByRole("link", { name: messages.admin.billingProfiles })
      .getAttribute("href"),
  ).toBe("/admin/billing");
  expect(
    button(messages.billing.invoiceComposer.issueInvoice).disabled,
  ).toBeTrue();
});

test("a refused issue shows the reason its code names, and that the draft was kept", async () => {
  // Ready when reviewed; the series is gone by the time the issue arrives.
  transitionAnswer = Response.json(
    {
      code: INVOICE_ISSUE_BLOCKER.numberSeriesMissing,
      message: "No default number series configured for this document type",
      hint: "Create a number series (number-series.create) for this documentType and this seller or all sellers, set it as default, then finalize again.",
    },
    { status: 409 },
  );
  await mountAtIssueStep([]);
  expect(
    screen.getByText(messages.billing.invoiceComposer.readyTitle),
  ).toBeDefined();

  await click(messages.billing.invoiceComposer.issueInvoice);

  await waitFor(() =>
    expect(toastText("title")).toEqual([
      messages.errors.apiCodes.invoiceNumberSeriesMissing,
    ]),
  );
  expect(toastText("description")).toEqual([
    messages.billing.invoiceComposer.issueFailed,
  ]);
  expect(requests).toEqual([
    `PUT /v1/invoices/${WORKSPACE_ID}`,
    `POST /v1/invoices/${WORKSPACE_ID}/${INVOICE_ID}/transition`,
  ]);
});

test("a refusal without a code keeps the generic message", async () => {
  transitionAnswer = Response.json(
    { message: "Cannot finalize invoice from its current status" },
    { status: 409 },
  );
  await mountAtIssueStep([]);

  await click(messages.billing.invoiceComposer.issueInvoice);

  await waitFor(() =>
    expect(toastText("title")).toEqual([
      messages.billing.invoiceComposer.issueFailed,
    ]),
  );
  expect(toastText("description")).toEqual([]);
});
