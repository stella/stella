import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { cents } from "@stll/money";

import { toSafeId } from "@/lib/safe-id";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({
  url: "http://localhost:3000/workspaces/matter-1/invoices/invoice-1",
});
Object.assign(import.meta.env, { VITE_API_URL: "http://localhost:3001" });

const WORKSPACE_ID = "019a0000-0000-7000-8000-000000000001";
const INVOICE_ID = "019a0000-0000-7000-8000-000000000002";
const ORIGINAL_FETCH = globalThis.fetch;
const requests: string[] = [];
const bootstrapFetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});

globalThis.fetch = bootstrapFetch;

const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { cleanup, render, waitFor } = await import("@testing-library/react");
const router = await import("@tanstack/react-router");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { default: messages } = await import("@/i18n/langs/en.json");
const { roleOptions } = await import("@/lib/auth-queries");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { invoiceByIdOptions } =
  await import("@/lib/workspaces/queries/invoices");
const { Route: invoiceRoute } =
  await import("@/routes/_protected.workspaces/$workspaceId/invoices/$invoiceId");

type Invoice = Awaited<
  ReturnType<NonNullable<ReturnType<typeof invoiceByIdOptions>["queryFn"]>>
>;

const invoice = {
  id: toSafeId<"invoice">(INVOICE_ID),
  workspaceId: toSafeId<"workspace">(WORKSPACE_ID),
  clientId: null,
  organizationId: toSafeId<"organization">(
    "019a0000-0000-7000-8000-000000000003",
  ),
  status: "sent",
  documentType: "invoice",
  currency: "EUR",
  language: "en",
  invoiceNumber: "INV-2026-001",
  invoiceDate: "2026-01-15",
  dueDate: "2026-02-15",
  taxableSupplyDate: null,
  reference: null,
  originalInvoiceId: null,
  sellerProfileId: null,
  buyerName: "Kovář Legal",
  buyerRegistrationId: null,
  buyerTaxId: null,
  buyerVatId: null,
  buyerAddressLine1: null,
  buyerAddressLine2: null,
  buyerCity: null,
  buyerPostalCode: null,
  buyerCountry: null,
  billingMode: "hourly",
  flatFeeAmount: null,
  notes: null,
  vatExchangeRate: null,
  vatExchangeRateSource: null,
  vatExchangeRateDate: null,
  vatExchangeRateReference: null,
  vatExchangeRateTaxPoint: null,
  netAmount: cents(0),
  vatAmount: cents(0),
  totalAmount: cents(0),
  totals: {
    netAmountMinor: cents(0),
    vatAmountMinor: cents(0),
    grossAmountMinor: cents(0),
    vatBreakdown: [],
  },
  lines: [],
  timeEntries: [],
  expenses: [],
  payments: [],
  paidAmount: cents(0),
  outstandingAmount: cents(0),
  sentAt: "2026-01-15T10:00:00.000Z",
  paidAt: null,
  finalizedAt: "2026-01-15T10:00:00.000Z",
  createdAt: "2026-01-15T10:00:00.000Z",
  updatedAt: "2026-01-15T10:00:00.000Z",
} satisfies Invoice;

afterEach(() => {
  cleanup();
  globalThis.fetch = bootstrapFetch;
  requests.length = 0;
});

afterAll(async () => {
  globalThis.fetch = ORIGINAL_FETCH;
  await unregisterDomEnvironment();
});

const mountInvoice = async (role: "external" | "member") => {
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const pathname = new URL(request.url).pathname;
      requests.push(pathname);
      if (pathname.endsWith("/sends")) {
        return role === "external"
          ? Response.json({ message: "Unavailable" }, { status: 403 })
          : Response.json({ items: [], nextCursor: null });
      }
      if (pathname.startsWith("/api/auth/")) {
        return Response.json(null);
      }
      return Response.json(
        {
          message: `Unexpected invoice detail request: ${request.method} ${pathname}`,
        },
        { status: 500 },
      );
    },
    { preconnect: () => undefined },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(roleOptions.queryKey, role);
  client.setQueryData(
    invoiceByIdOptions(WORKSPACE_ID, INVOICE_ID).queryKey,
    invoice,
  );

  const component = invoiceRoute.options.component;
  if (!component) {
    throw new Error("Invoice detail route must declare a component");
  }
  const root = router.createRootRoute({ component: router.Outlet });
  const protectedRoute = router.createRoute({
    getParentRoute: () => root,
    id: "_protected",
  });
  const page = router.createRoute({
    getParentRoute: () => protectedRoute,
    path: "/workspaces/$workspaceId/invoices/$invoiceId",
    component,
  });
  const appRouter = router.createRouter({
    routeTree: root.addChildren([protectedRoute.addChildren([page])]),
    history: router.createMemoryHistory({
      initialEntries: [`/workspaces/${WORKSPACE_ID}/invoices/${INVOICE_ID}`],
    }),
    isServer: false,
  });
  await appRouter.load();
  const view = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <AuthenticatedUserProvider
            user={{
              activeOrganizationId: invoice.organizationId,
              email: "member@example.test",
              id: "member-1",
              image: null,
              name: "Member",
              preferredName: null,
              timezoneId: "UTC",
              wordEditShortcut: null,
            }}
          >
            <router.RouterProvider router={appRouter} />
          </AuthenticatedUserProvider>
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return { client, view };
};

test("a read-only member opens a sent invoice without requesting send history", async () => {
  const { client, view } = await mountInvoice("external");

  expect(await view.findByText(invoice.invoiceNumber)).toBeDefined();
  expect(requests.some((pathname) => pathname.endsWith("/sends"))).toBe(false);
  expect(
    view.queryByText(messages.billing.invoices.sending.historyTitle),
  ).toBeNull();
  expect(
    view.queryByText(messages.billing.invoices.sending.loadFailed),
  ).toBeNull();
  view.unmount();
  client.clear();
});

test("a member with invoice update permission loads send history", async () => {
  const { client, view } = await mountInvoice("member");

  expect(
    await view.findByText(messages.billing.invoices.sending.historyTitle),
  ).toBeDefined();
  await waitFor(() => {
    expect(requests.some((pathname) => pathname.endsWith("/sends"))).toBe(true);
  });
  expect(
    view.queryByText(messages.billing.invoices.sending.historyEmpty),
  ).toBeDefined();
  view.unmount();
  client.clear();
});
