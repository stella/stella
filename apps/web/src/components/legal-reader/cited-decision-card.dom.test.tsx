import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { CaseLawDecisionSummary } from "@stll/api-contract/case-law-decision-summary";

import { unregisterDomEnvironment } from "@/test-dom-environment";

import { dockedChatLegalPayloads } from "../../../e2e/helpers/docked-chat-legal-payloads";

GlobalRegistrator.register({ url: "http://localhost:3000/law/cze/cases" });
const { cleanup, render, screen } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { decisionCardSummaryOptions } =
  await import("@/features/case-law/queries/decisions");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { CitedDecisionCard } = await import("./cited-decision-link");
const messages = (await import("@/i18n/langs/en.json")).default;
const originalFetch = globalThis.fetch;

const cited = {
  ...dockedChatLegalPayloads.decision,
  citationCount: 23,
  court: "Nejvyšší soud",
  courtAbbreviation: "NS",
  courtTier: "supreme" as const,
  decisionDate: "2019-10-16",
  decisionType: "usnesení",
  headnote: {
    type: "present" as const,
    text: "The cited decision's official legal sentence.",
    truncated: false,
  },
  publication: "Sb. NS 10/2019",
};
const clients: InstanceType<typeof QueryClient>[] = [];

const mount = (decision: CaseLawDecisionSummary, children: ReactNode) => {
  const client = new QueryClient();
  clients.push(client);
  client.setQueryData(
    decisionCardSummaryOptions(decision.id).queryKey,
    decision,
  );
  return render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          {children}
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

test("describes a headnoted decision without a reader presentation provider", () => {
  const citingParagraph = "The paragraph already visible in the reader.";
  mount(
    cited,
    <>
      <span>{citingParagraph}</span>
      <CitedDecisionCard decision={cited} treatment="supportive" />
    </>,
  );

  expect(screen.getByText(cited.court)).toBeTruthy();
  expect(screen.getByText(cited.caseNumber)).toBeTruthy();
  expect(screen.getByText("usnesení")).toBeTruthy();
  expect(screen.getByText(cited.headnote.text)).toBeTruthy();
  expect(screen.getByText("NS")).toBeTruthy();
  expect(screen.getByText("Cited 23 times")).toBeTruthy();
  expect(screen.getByText("Sb. NS 10/2019")).toBeTruthy();
  expect(
    screen.getByText(messages.caseLaw.citation.treatment.supportive).className,
  ).toContain("rounded-full");
  expect(screen.getAllByText(citingParagraph)).toHaveLength(1);
});

test("omits absent headnote, decision type, date and publication", () => {
  const sparse = {
    ...cited,
    decisionDate: null,
    decisionType: null,
    headnote: { type: "absent" as const, reason: "not_published" as const },
    publication: null,
  };
  mount(sparse, <CitedDecisionCard decision={sparse} treatment={undefined} />);

  expect(screen.queryByText(cited.headnote.text)).toBeNull();
  expect(screen.queryByText("usnesení")).toBeNull();
  expect(screen.queryByText("Sb. NS 10/2019")).toBeNull();
  expect(
    screen.queryByText(messages.caseLaw.citation.dateUnavailable),
  ).toBeNull();
  expect(
    screen.queryByText(messages.caseLaw.citation.treatment.supportive),
  ).toBeNull();
});

test("loads the stored summary endpoint instead of the full decision read", async () => {
  const requests: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      requests.push(input instanceof Request ? input.url : input.toString());
      return Response.json(cited);
    },
    { preconnect: originalFetch.preconnect },
  );
  const client = new QueryClient();

  clients.push(client);
  const result = await client.query(decisionCardSummaryOptions(cited.id));

  expect(result.court).toBe(cited.court);
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0] ?? "").pathname).toEndWith(
    `/case/decisions/${cited.id}/summary`,
  );
  expect(new URL(requests[0] ?? "").pathname).not.toEndWith(
    `/case/decisions/${cited.id}`,
  );
  globalThis.fetch = originalFetch;
});

test("keeps the cited court and case number when the stored summary fails", async () => {
  globalThis.fetch = Object.assign(
    async () =>
      Response.json({ message: "Summary unavailable" }, { status: 503 }),
    { preconnect: originalFetch.preconnect },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <CitedDecisionCard decision={cited} treatment={undefined} />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );

  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByText(cited.court)).toBeTruthy();
  expect(screen.getByText(cited.caseNumber)).toBeTruthy();
});
