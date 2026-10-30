import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import englishMessages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });
const {
  createMatterViewTestRouter,
  EXPECTED_OTHER_TREE_REVEAL,
  seedTestMatterTrees,
  TEST_FOLDER_ID,
  TEST_MATTER_ID,
  TEST_OTHER_TREE_DOCUMENT_PATH,
} = await import("@/lib/workspaces/matter-view-test-router");
// The chip reads the entity it names; the fixture folder is the only one.
// Each test gets its own fetch spy, restored after it.
beforeEach(() => {
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const { pathname } = new URL(new Request(input, init).url);
        if (pathname.endsWith(`/${TEST_FOLDER_ID}`)) {
          return Response.json({
            kind: "folder",
            name: "Pleadings",
            fields: [],
          });
        }
        throw new TypeError(`Unexpected source chip request: ${pathname}`);
      },
      { preconnect: () => undefined },
    ),
  );
});
const { fireEvent, render, screen, cleanup, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { RouterProvider } = await import("@tanstack/react-router");
const { SourceChips } = await import("@/features/chat/source-chips");

afterEach(() => {
  cleanup();
  // After unmounting, so a request a component makes on its way out still
  // reaches the spy.
  mock.restore();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

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
        <FormattingProvider locale="en" timeZone="UTC">
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
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );

const renderInvalidDateSource = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
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
        </FormattingProvider>
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

test("a decision row opens in the app on a plain click, links otherwise", () => {
  const decisionId = "a5a95801-7a7c-4c8b-98b3-7d17c8b8d7f9";
  render(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
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
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  // Records whether the row handled the click, then stops the test browser
  // from following a link it left alone.
  const click = (caseNumber: RegExp, init: MouseEventInit = {}) => {
    let handledByRow = false;
    const settle = (event: Event) => {
      handledByRow = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener("click", settle);
    try {
      screen
        .getByText(caseNumber, { selector: ".font-medium" })
        .closest("a")
        ?.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            button: 0,
            cancelable: true,
            ...init,
          }),
        );
    } finally {
      document.removeEventListener("click", settle);
    }
    return handledByRow;
  };

  // The decision opens beside the chat instead of leaving for the source.
  expect(click(/4 Cdo 4\/26/u)).toBe(true);
  // A modifier click keeps the browser's own new-tab behavior.
  expect(click(/4 Cdo 4\/26/u, { metaKey: true })).toBe(false);
  // Without a decision id the row is a plain link.
  expect(click(/5 Cdo 5\/26/u)).toBe(false);
});

test("a cited folder reveals itself in the tree on screen, not the first tree", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  seedTestMatterTrees(queryClient);
  const Answer = () => (
    <SourceChips
      messageId="folder-answer"
      parts={[
        {
          type: "text",
          content: `[Pleadings](#stella-entity=${TEST_MATTER_ID}:${TEST_FOLDER_ID})`,
        },
      ]}
      sourceDocuments={[
        {
          entityId: TEST_FOLDER_ID,
          kind: "folder",
          mimeType: null,
          title: "Pleadings",
          workspaceId: TEST_MATTER_ID,
        },
      ]}
      workspaceId={TEST_MATTER_ID}
    />
  );
  const router = await createMatterViewTestRouter(
    TEST_OTHER_TREE_DOCUMENT_PATH,
    Answer,
  );
  render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
        <RouterProvider router={router} />
      </IntlProvider>
    </QueryClientProvider>,
  );

  fireEvent.click(await screen.findByRole("button", { name: /Pleadings/u }));

  await waitFor(() =>
    expect({
      pathname: router.state.location.pathname,
      search: router.state.location.search,
    }).toEqual(EXPECTED_OTHER_TREE_REVEAL),
  );
});
