import type { ComponentProps } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { DecisionCitationSummary } from "@/features/case-law/citation-treatment";
import { toSafeId } from "@/lib/safe-id";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});
const { cleanup, render, waitFor, fireEvent, act } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { TopBarCitationsFor } = await import("./top-bar-citations");
const { decisionCitationSummaryOptions } =
  await import("@/features/case-law/queries/citations");
const messages = (await import("@/i18n/langs/en.json")).default;
const arabicMessages = (await import("@/i18n/langs/ar.json")).default;
const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const decision = {
  id: toSafeId<"caseLawDecision">("00000000-0000-4000-8000-000000000001"),
  decisionDate: "2020-01-01",
  caseNumber: "1 C 1/2020",
  country: "CZ",
  court: "supreme",
  language: "cs",
  languageAlternates: [],
  slug: "decision",
} satisfies ComponentProps<typeof TopBarCitationsFor>["decision"];
const summary = (positive: number) =>
  ({
    incoming: {
      positive,
      supportive: 0,
      negative: 0,
      neutral: 0,
      mixed: 0,
      unclassified: 0,
    },
    outgoing: {
      positive: 0,
      supportive: 0,
      negative: 0,
      neutral: 0,
      mixed: 0,
      unclassified: 0,
    },
    capped: { incoming: false, outgoing: false },
    incomingByYear: [],
  }) satisfies DecisionCitationSummary;
const defaultLocaleOptions = { locale: "en", messages };
const mount = (
  client: InstanceType<typeof QueryClient>,
  { locale, messages: catalog } = defaultLocaleOptions,
) =>
  render(
    <QueryClientProvider client={client}>
      <IntlProvider locale={locale} messages={catalog} timeZone="UTC">
        <FormattingProvider locale={locale} timeZone="UTC">
          <TopBarCitationsFor decision={decision} />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );

for (const [locale, catalog] of Object.entries({
  en: messages,
  ar: arabicMessages,
})) {
  test(`${locale}: citation summary read exposes pending, retry, and an authoritative empty result`, async () => {
    const pending = Promise.withResolvers<Response>();
    let attempts = 0;
    globalThis.fetch = Object.assign(
      async () => {
        attempts += 1;
        return attempts === 1 ? pending.promise : Response.json(summary(0));
      },
      { preconnect: () => undefined },
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    clients.push(client);
    const screen = mount(client, { locale, messages: catalog });
    expect(screen.queryByRole("status")).not.toBeNull();
    await act(async () => {
      pending.resolve(
        Response.json({ message: "Read unavailable" }, { status: 503 }),
      );
    });
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: catalog.common.retry }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(attempts).toBe(2);
    expect(screen.queryByRole("button")).toBeNull();
  });
}

for (const count of [0, 2]) {
  test(`citation summary retains cached count ${count} with a refetch notice`, async () => {
    globalThis.fetch = Object.assign(
      async () =>
        Response.json({ message: "Read unavailable" }, { status: 503 }),
      { preconnect: () => undefined },
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    clients.push(client);
    const options = decisionCitationSummaryOptions(decision.id);
    client.setQueryData(options.queryKey, summary(count));
    const screen = mount(client);
    await act(async () => {
      await client.invalidateQueries({ queryKey: options.queryKey });
    });
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeNull());
    if (count > 0) {
      expect(screen.getByText(String(count))).toBeTruthy();
    }
    expect(
      screen.getByRole("button", { name: messages.common.retry }),
    ).toBeTruthy();
  });
}
