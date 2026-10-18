import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import { unregisterDomEnvironment } from "@/test-dom-environment";

import { dockedChatLegalPayloads } from "../../../e2e/helpers/docked-chat-legal-payloads";

GlobalRegistrator.register({ url: "http://localhost:3000/law/cze/cases" });
const { cleanup, render, screen } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { WebReaderPresentationProvider } =
  await import("@/components/legal-reader/web-reader-presentation");
const { decisionOptions } =
  await import("@/features/case-law/queries/decisions");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { CitedDecisionCard } = await import("./cited-decision-link");
const messages = (await import("@/i18n/langs/en.json")).default;

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
  },
  identifiers: [
    {
      type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      value: "29 Cdo 4097/2014",
    },
    {
      type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
      value: "Sb. NS 10/2019",
    },
  ],
};
const clients: InstanceType<typeof QueryClient>[] = [];

const mount = (decision: typeof cited, children: ReactNode) => {
  const client = new QueryClient();
  clients.push(client);
  client.setQueryData(decisionOptions(decision.id).queryKey, decision);
  return render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <WebReaderPresentationProvider>
            {children}
          </WebReaderPresentationProvider>
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
};

afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
});
afterAll(async () => unregisterDomEnvironment());

test("describes the cited decision instead of repeating the citing paragraph", () => {
  const citingParagraph = "The paragraph already visible in the reader.";
  mount(
    cited,
    <>
      <span>{citingParagraph}</span>
      <CitedDecisionCard decisionId={cited.id} treatment="supportive" />
    </>,
  );

  expect(screen.getByText(cited.court)).toBeTruthy();
  expect(screen.getByText(cited.caseNumber)).toBeTruthy();
  expect(screen.getByText("usnesení")).toBeTruthy();
  expect(screen.getByText(cited.headnote.text)).toBeTruthy();
  expect(screen.getByText("NS")).toBeTruthy();
  expect(screen.getByText("Cited by 23")).toBeTruthy();
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
    identifiers: cited.identifiers.slice(0, 1),
  };
  mount(
    sparse,
    <CitedDecisionCard decisionId={sparse.id} treatment={undefined} />,
  );

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
