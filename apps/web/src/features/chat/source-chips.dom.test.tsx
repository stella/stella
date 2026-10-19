import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import englishMessages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });
const { fireEvent, render, screen, cleanup } =
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
