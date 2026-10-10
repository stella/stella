import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

import type { DecisionCitationSummary } from "@/features/case-law/citation-treatment";
import { toSafeId } from "@/lib/safe-id";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
const { act, cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { DecisionCitationBox } = await import("./decision-citation-box");
const {
  CITATION_DIRECTIONS,
  decisionCitationSummaryOptions,
  decisionCitationsInfiniteOptions,
} = await import("@/features/case-law/queries/citations");
const { decisionProvisionsInfiniteOptions } =
  await import("@/features/case-law/queries/provisions");
const messages = (await import("@/i18n/langs/en.json")).default;
const decisionId = toSafeId<"caseLawDecision">(
  "00000000-0000-4000-8000-000000000001",
);
const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
});

afterAll(async () => {
  // The expanded box mounts ProvisionsCited, whose scheduled render work must
  // run before the DOM globals go away.
  await act(async () => {
    await sleep(0);
  });
  await unregisterDomEnvironment();
});

const summary = {
  incoming: {
    mixed: 0,
    negative: 1,
    neutral: 0,
    positive: 2,
    supportive: 0,
    unclassified: 0,
  },
  outgoing: {
    mixed: 0,
    negative: 0,
    neutral: 4,
    positive: 0,
    supportive: 0,
    unclassified: 0,
  },
  capped: { incoming: false, outgoing: false },
  incomingByYear: [
    {
      year: 2024,
      mixed: 0,
      negative: 1,
      neutral: 0,
      positive: 2,
      supportive: 0,
      unclassified: 0,
    },
  ],
} satisfies DecisionCitationSummary;

const mount = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  clients.push(client);
  client.setQueryData(
    decisionCitationSummaryOptions(decisionId).queryKey,
    summary,
  );
  for (const direction of CITATION_DIRECTIONS) {
    const options = decisionCitationsInfiniteOptions(decisionId, direction);
    client.setQueryData(options.queryKey, {
      pageParams: [null],
      pages: [{ items: [], nextCursor: null, limit: 20 }],
    });
  }
  const provisions = decisionProvisionsInfiniteOptions(decisionId);
  client.setQueryData(provisions.queryKey, {
    pageParams: [null],
    pages: [
      {
        items: [
          {
            anchor: "s265b",
            confidence: 0.9,
            jurisdiction: "CZE",
            letter: null,
            openEnded: false,
            point: null,
            section: 265,
            sectionSuffix: "b",
            sentence: null,
            sentenceText: "The court applies the provision.",
            spanEnd: 40,
            spanStart: 0,
            subsection: "1",
            unit: "section",
            workCollection: "Sb.",
            workEli: null,
            workIdentifier: "141/1961",
            workNumber: 141,
            workSource: "number",
            workYear: 1961,
            versionValidFrom: null,
            versionBasis: { type: "inferred", kind: "decision_date" },
            inferredVersionCandidate: {
              type: "inferred",
              kind: "decision_date",
              versionValidFrom: null,
            },
            previewKey: null,
            spanRole: null,
            printPieceId: null,
            printStart: null,
            printEnd: null,
            printText: null,
            namePieceId: null,
            nameStart: null,
            nameEnd: null,
            nameText: null,
            selection: null,
            printedWorkIdentifier: null,
            targetDocumentId: null,
            targetStatus: null,
          },
        ],
        limit: 50,
        nextCursor: null,
        previews: [],
        status: { type: "legacy" },
        generation: "0",
        publishedProjectionDigest: null,
      },
    ],
  });
  render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <DecisionCitationBox
            decision={{
              caseNumber: "1 C 1/2020",
              caseNumberType: "case-number",
              country: "CZ",
              court: "Supreme Court",
              courtAbbreviation: null,
              sourceUrl: null,
              decisionDate: "2020-01-01",
              decisionType: null,
              ecli: null,
              id: decisionId,
              language: "en",
              languageAlternates: [],
              slug: "decision",
            }}
            decisionDate="2020-01-01"
            decisionId={decisionId}
          />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return client;
};

test("the collapsed box shows the chart and counts from the loaded summaries", async () => {
  mount();

  await waitFor(() => {
    expect(
      screen.getByRole("img", { name: messages.caseLaw.citation.stripLabel }),
    ).toBeTruthy();
  });
  expect(screen.getByText("Cited by 3")).toBeTruthy();
  expect(screen.getByText("Cites 4")).toBeTruthy();
  expect(screen.getByText("Provisions cited 1")).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: /Citations/u })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  expect(
    screen.queryByRole("heading", { name: messages.caseLaw.viewer.citedBy }),
  ).toBeNull();
});

test("expanding the box reveals all three citation lists", async () => {
  mount();
  const disclosure = await screen.findByRole("button", {
    name: /Citations/u,
  });
  fireEvent.click(disclosure);

  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: messages.caseLaw.viewer.citedBy }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: messages.caseLaw.viewer.cites }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        name: messages.caseLaw.viewer.provisionsCited,
      }),
    ).toBeTruthy();
    expect(screen.getByText(/§ 265b/u)).toBeTruthy();
  });
});
