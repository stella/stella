import type { ComponentProps } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, expect, test } from "bun:test";

import { cents } from "@stll/money";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/invoice-link" });
Object.assign(import.meta.env, { VITE_API_URL: "http://localhost:3001" });

const { renderToStaticMarkup } = await import("react-dom/server");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { default: messages } = await import("@/i18n/langs/en.json");
const { InvoiceSummary } = await import("./invoice-link");

const invoice = {
  title: "Invoice 2026-18",
  language: "en",
  dir: "ltr",
  documentType: "invoice",
  paid: false,
  outstandingAmount: cents(12_000),
  seller: "Legal practice",
  buyer: "Client",
  meta: [{ label: "Invoice number", value: "2026-18" }],
  totals: [
    { label: "Net", value: "EUR 100.00" },
    { label: "VAT", value: "EUR 20.00" },
    { label: "Amount due", value: "EUR 120.00" },
  ],
  payment: null,
  files: { pdf: { fileName: "2026-18.pdf" }, eInvoice: null },
  expiresAt: "2026-11-01T00:00:00.000Z",
} satisfies ComponentProps<typeof InvoiceSummary>["invoice"];

afterAll(unregisterDomEnvironment);

test("the amount-due label and value are emphasised without changing fact order", () => {
  const client = new QueryClient();
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <InvoiceSummary invoice={invoice} token={"0f".repeat(32)} />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  client.clear();
  const host = document.createElement("div");
  // safe-html: React renderToStaticMarkup escapes this test's fixed invoice values.
  host.innerHTML = markup;
  const grid =
    host.querySelector('[data-slot="details-grid"]') ??
    panic("Missing invoice details");
  const rows = Array.from(grid.querySelectorAll('[data-slot="details-item"]'));
  const facts = [...invoice.meta, ...invoice.totals];
  expect(
    rows.map((row) => [
      row.querySelector("dt")?.textContent,
      row.querySelector("dd")?.textContent,
    ]),
  ).toEqual(facts.map(({ label, value }) => [label, value]));
  const last = rows.at(-1) ?? panic("Missing amount-due row");
  expect(last.querySelector("dt .font-semibold")?.textContent).toBe(
    "Amount due",
  );
  expect(last.querySelector("dd .font-semibold")?.textContent).toBe(
    "EUR 120.00",
  );
  for (const row of rows.slice(0, -1)) {
    expect(row.querySelector(".font-semibold")).toBeNull();
  }
});
