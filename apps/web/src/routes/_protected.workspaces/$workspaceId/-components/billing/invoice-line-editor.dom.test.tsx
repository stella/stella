import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";

import { CAPABILITY_REQUEST_HEADER } from "@stll/api-contract/capability-request";
import { cents } from "@stll/money";

import messages from "@/i18n/langs/en.json";
import { toSafeId } from "@/lib/safe-id";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({
  url: "http://localhost:3000/workspaces/matter-1/invoices/invoice-1",
});

const { act } = await import("react");
const { cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { stellaToast } = await import("@stll/ui/toast");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { allInvoicesQueryRoot, allTimeEntriesQueryRoot } =
  await import("@/lib/resource-query-roots.logic");
const { InvoiceLineEditor } = await import("./invoice-line-editor");

type InvoiceLine = Parameters<typeof InvoiceLineEditor>[0]["line"];

const WORKSPACE = "matter-1";
const INVOICE = "invoice-1";
const LINE = "line-1";
const LINE_PATH = `/invoices/${WORKSPACE}/${INVOICE}/lines/${LINE}`;
// A currency without minor units: happy-dom's step check flags whole amounts
// against a 0.01 step as mismatched, which a browser accepts.
const CURRENCY = "JPY";
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

/** A draft line billing 1.5 hours at 2,500 yen, as the invoice recorded it. */
const draftLine = (overrides: Partial<InvoiceLine> = {}): InvoiceLine =>
  ({
    workspaceId: toSafeId<"workspace">(WORKSPACE),
    id: toSafeId<"invoiceLine">(LINE),
    position: 0,
    recordedDescription: "Lease review",
    recordedQuantity: "1.5",
    recordedUnit: "h",
    recordedUnitPrice: cents(2500),
    recordedNetAmount: cents(3750),
    description: "Lease review",
    quantity: "1.5",
    unit: "h",
    unitPrice: cents(2500),
    vatRateBps: 1000,
    vatTreatment: "domestic_vat",
    exemptionReason: null,
    netAmount: cents(3750),
    vatAmount: cents(375),
    grossAmount: cents(4125),
    source: "time_entry",
    billingPurpose: "ordinary",
    timeEntryId: toSafeId<"timeEntry">("entry-1"),
    expenseId: null,
    releasedAt: null,
    workspace: {
      id: toSafeId<"workspace">(WORKSPACE),
      name: "Lease",
      color: null,
    },
    ...overrides,
  }) satisfies InvoiceLine;

type ApiCall = {
  method: string;
  path: string;
  capability: string | null;
  body: unknown;
};

/** The line endpoints: each write answers ok unless the test refuses it. */
const serveLines = ({ refuse = false }: { refuse?: boolean } = {}) => {
  const calls: ApiCall[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname.replace(/^.*\/v1/u, "");
      const text = await request.text();
      calls.push({
        method: request.method,
        path,
        capability: request.headers.get(CAPABILITY_REQUEST_HEADER),
        body: text === "" ? null : JSON.parse(text),
      });
      if (refuse) {
        return Response.json(
          {
            code: "invoice_not_draft",
            message: "Only a draft invoice can change",
          },
          { status: 409 },
        );
      }
      return Response.json({ id: LINE });
    },
    { preconnect: originalFetch.preconnect },
  );
  return calls;
};

const mount = (line: InvoiceLine, editable = true) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  // The invoice and the time behind it, as the detail page holds them.
  client.setQueryData([...allInvoicesQueryRoot(), "detail"], { id: INVOICE });
  client.setQueryData([...allTimeEntriesQueryRoot(), "list"], { items: [] });
  render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en-GB" timeZone="UTC">
          <InvoiceLineEditor
            currency={CURRENCY}
            editable={editable}
            invoiceId={INVOICE}
            line={line}
            workspaceId={WORKSPACE}
          />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return client;
};

const invalidated = (
  client: InstanceType<typeof QueryClient>,
  key: readonly unknown[],
) => client.getQueryState(key)?.isInvalidated === true;

const field = (name: string) => screen.getByRole("textbox", { name });

const typeInto = async (input: HTMLElement, value: string) => {
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
};

const click = async (name: string) => {
  const button = screen.getByRole("button", { name });
  await act(async () => {
    fireEvent.click(button);
  });
};

describe("editing a draft invoice line", () => {
  test("saving sends only what changed and refreshes the invoice and its time", async () => {
    const calls = serveLines();
    const client = mount(draftLine());
    // Nothing to save until a value changes.
    expect(
      screen.queryByRole("button", { name: messages.common.save }),
    ).toBeNull();

    await typeInto(field(messages.common.description), "Lease review, call");
    await click(messages.common.save);

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]).toEqual({
      method: "PATCH",
      path: LINE_PATH,
      capability: "invoices.lines.update",
      body: { description: "Lease review, call" },
    });
    await waitFor(() => {
      expect(invalidated(client, [...allInvoicesQueryRoot(), "detail"])).toBe(
        true,
      );
      expect(invalidated(client, [...allTimeEntriesQueryRoot(), "list"])).toBe(
        true,
      );
    });
  });

  test("a changed quantity and unit price go out in minor units", async () => {
    const calls = serveLines();
    mount(draftLine());

    await typeInto(
      field(messages.billing.invoices.lineOverrides.quantity),
      "2",
    );
    const rate = screen.getByRole("spinbutton", {
      name: messages.billing.invoiceComposer.rate,
    });
    await typeInto(rate, "3000");
    await click(messages.common.save);

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.body).toEqual({
      description: "Lease review",
      quantity: "2",
      unitPriceMinor: 3000,
    });
  });

  test("a refused save says so and keeps the edit", async () => {
    serveLines({ refuse: true });
    const toasts = spyOn(stellaToast, "add");
    try {
      mount(draftLine());

      await typeInto(field(messages.common.description), "Lease review, call");
      await click(messages.common.save);

      await waitFor(() => {
        expect(toasts).toHaveBeenCalled();
      });
      expect(field(messages.common.description)).toHaveProperty(
        "value",
        "Lease review, call",
      );
    } finally {
      toasts.mockRestore();
    }
  });

  test("an edited line shows what was recorded and resets to it", async () => {
    const calls = serveLines();
    const client = mount(
      draftLine({
        description: "Lease review and call",
        quantity: "2",
        unitPrice: cents(3000),
        netAmount: cents(6000),
      }),
    );

    expect(
      screen.getByText(/^Edited · recorded: Lease review, 1\.5 × /u),
    ).toBeTruthy();
    await click(messages.billing.invoices.lineOverrides.resetRecorded);

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]).toEqual({
      method: "PATCH",
      path: LINE_PATH,
      capability: "invoices.lines.update",
      body: { resetToRecorded: true },
    });
    await waitFor(() => {
      expect(invalidated(client, [...allInvoicesQueryRoot(), "detail"])).toBe(
        true,
      );
    });
  });

  test("a line as recorded offers no reset", () => {
    serveLines();
    mount(draftLine());

    expect(
      screen.queryByRole("button", {
        name: messages.billing.invoices.lineOverrides.resetRecorded,
      }),
    ).toBeNull();
    expect(screen.queryByText(/^Edited · recorded/u)).toBeNull();
  });

  test("removing a line deletes it from the draft and refreshes its time", async () => {
    const calls = serveLines();
    const client = mount(draftLine());

    await click(messages.common.remove);

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]).toEqual({
      method: "DELETE",
      path: LINE_PATH,
      capability: "invoices.lines.delete",
      body: {},
    });
    await waitFor(() => {
      expect(invalidated(client, [...allTimeEntriesQueryRoot(), "list"])).toBe(
        true,
      );
    });
  });

  test("the flat fee keeps its amount and cannot be removed", () => {
    serveLines();
    mount(draftLine({ billingPurpose: "flat_fee", source: "manual" }));

    expect(
      screen.queryByRole("button", { name: messages.common.remove }),
    ).toBeNull();
    expect(
      field(messages.billing.invoices.lineOverrides.quantity),
    ).toHaveProperty("readOnly", true);
    expect(
      screen.getByRole("spinbutton", {
        name: messages.billing.invoiceComposer.rate,
      }),
    ).toHaveProperty("readOnly", true);
  });

  test("an issued invoice's line is read-only", () => {
    serveLines();
    mount(draftLine(), false);

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(within(document.body).getByText("Lease review")).toBeTruthy();
  });
});
