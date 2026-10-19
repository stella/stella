import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, test } from "bun:test";

import englishMessages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });
const { fireEvent, render, screen, cleanup, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { SourceChips } = await import("@/features/chat/source-chips");

afterEach(cleanup);
afterAll(unregisterDomEnvironment);

const hit = (
  url: string,
  caseNumber: string,
  court: string,
  courtAbbreviation: string,
) => ({
  url,
  caseNumber,
  court,
  courtAbbreviation,
  decisionDate: "2026-01-02",
  summary: `Holding for ${caseNumber}`,
});

const renderSources = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
        <SourceChips
          messageId="answer"
          parts={[
            {
              type: "tool-call",
              id: "search",
              name: "infosoud_lookup_case",
              state: "complete",
              arguments: "{}",
              input: {},
              output: {
                results: [
                  hit(
                    "https://example.test/cases/cited",
                    "I. ÚS 1/26",
                    "Ústavní soud",
                    "ÚS",
                  ),
                  hit(
                    "https://example.test/cases/consulted",
                    "2 Cdo 2/26",
                    "Nejvyšší soud",
                    "NS",
                  ),
                ],
              },
            },
            {
              type: "text",
              content: "[authority](https://example.test/cases/cited)",
            },
          ]}
        />
      </IntlProvider>
    </QueryClientProvider>,
  );

const renderInvalidDateSource = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
        <SourceChips
          messageId="invalid-date-answer"
          parts={[
            {
              type: "tool-call",
              id: "search",
              name: "infosoud_lookup_case",
              state: "complete",
              arguments: "{}",
              input: {},
              output: {
                url: "https://example.test/cases/invalid-date",
                caseNumber: "3 Cdo 3/26",
                court: "Nejvyšší soud",
                courtAbbreviation: "NS",
                decisionDate: "not-a-date",
              },
            },
          ]}
        />
      </IntlProvider>
    </QueryClientProvider>,
  );

test("shows cited court groups and keeps consulted decisions collapsed", () => {
  renderSources();
  expect(
    screen.getByRole("heading", { name: "Constitutional courts" }),
  ).toBeTruthy();
  expect(
    screen.getByText(/I\. ÚS 1\/26/u, { selector: ".font-medium" }),
  ).toBeTruthy();
  const disclosure = screen.getByText("Also consulted (1)");
  const details = disclosure.closest("details");
  expect(details?.open).toBe(false);
  fireEvent.click(disclosure);
  expect(details?.open).toBe(true);
  expect(screen.getByRole("heading", { name: "Supreme courts" })).toBeTruthy();
  expect(screen.getAllByText(/2 Cdo 2\/26/u).length).toBeGreaterThan(0);
  for (const abbreviation of ["ÚS", "NS", "NSS", "VS", "KS", "MS", "OS"]) {
    expect(
      screen.queryByText(abbreviation, {
        selector: "[data-chat-answer-citations] *:only-child",
      }),
    ).toBeNull();
  }
});

test("renders a case-law source without an invalid decision date", () => {
  renderInvalidDateSource();
  const disclosure = screen.getByText("Also consulted (1)");
  fireEvent.click(disclosure);
  expect(
    screen.getByText("3 Cdo 3/26", { selector: ".font-medium" }),
  ).toBeTruthy();
  expect(screen.queryByText(/not-a-date/u)).toBeNull();
});

test("a decision row opens the decision instead of navigating", async () => {
  const decisionId = "a5a95801-7a7c-4c8b-98b3-7d17c8b8d7f9";
  // Opening resolves the decision through the API; the request names it.
  const realFetch = globalThis.fetch;
  const fetchSpy = mock(
    async (_input: RequestInfo | URL) =>
      await Promise.resolve(new Response("{}", { status: 404 })),
  );
  globalThis.fetch = Object.assign(fetchSpy, {
    preconnect: realFetch.preconnect,
  });
  try {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
          <SourceChips
            messageId="decision-row-answer"
            parts={[
              {
                type: "tool-call",
                id: "search",
                name: "infosoud_lookup_case",
                state: "complete",
                arguments: "{}",
                input: {},
                output: {
                  results: [
                    {
                      ...hit(
                        "https://example.test/cases/with-id",
                        "4 Cdo 4/26",
                        "Nejvyšší soud",
                        "NS",
                      ),
                      decisionId,
                    },
                    hit(
                      "https://example.test/cases/without-id",
                      "5 Cdo 5/26",
                      "Nejvyšší soud",
                      "NS",
                    ),
                  ],
                },
              },
              {
                type: "text",
                content:
                  "[a](https://example.test/cases/with-id) [b](https://example.test/cases/without-id)",
              },
            ]}
          />
        </IntlProvider>
      </QueryClientProvider>,
    );
    const rowFor = (caseNumber: RegExp) =>
      screen.getByText(caseNumber, { selector: ".font-medium" }).closest("a");
    const withId = new MouseEvent("click", { bubbles: true, cancelable: true });
    rowFor(/4 Cdo 4\/26/u)?.dispatchEvent(withId);
    expect(withId.defaultPrevented).toBe(true);
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(([input]) =>
          String(input).includes(decisionId),
        ),
      ).toBe(true);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});
