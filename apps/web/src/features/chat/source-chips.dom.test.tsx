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

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import czechMessages from "@/i18n/langs/cs.json";
import englishMessages from "@/i18n/langs/en.json";

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

/** The chip a group of cited sources reads as, by its name and count. */
const groupChip = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^${name}\\s*\\d+$`, "u") });

test("names what the answer cites by court, with what it consulted folded beside it", () => {
  renderSources();
  const row = document.querySelector("[data-chat-answer-citations]");
  expect(row?.textContent).toContain("Sources");
  const chip = groupChip("Ústavní soud");
  expect(chip.textContent).toBe("Ústavní soud1");
  // The cited decision opens from its court's chip, in the tray's own row.
  expect(screen.queryByText(/I\. ÚS 1\/26/u)).toBeNull();
  fireEvent.click(chip);
  expect(
    screen.getByText(/I\. ÚS 1\/26/u, { selector: ".font-medium" }),
  ).toBeTruthy();
  const disclosure = screen.getByRole("button", { name: "+1 more consulted" });
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(disclosure);
  expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("heading", { name: "Supreme courts" })).toBeTruthy();
  expect(screen.getAllByText(/2 Cdo 2\/26/u).length).toBeGreaterThan(0);
});

test("a cited decision is one uncapped line in its court's list", () => {
  renderSources();
  const citations = document.querySelector("[data-chat-answer-citations]");
  // The row's items are items of the footer row itself, so they sit beside
  // Copy and Retry rather than in a full-width block below.
  expect(citations?.className).toBe("contents");
  fireEvent.click(groupChip("Ústavní soud"));
  const label = screen.getByText(/I\. ÚS 1\/26 · /u, {
    selector: ".font-medium",
  });
  // The case number and date keep the row's width, not the compact 20ch cap.
  const chipLabel = label.closest("bdi");
  expect(chipLabel?.className).toContain("min-w-0");
  expect(chipLabel?.className).not.toContain("max-w-[20ch]");
  // The holding is hover text, never a second row inside the chip.
  expect(label.parentElement?.className).toContain("items-center");
  expect(screen.queryByText("Holding for I. ÚS 1/26")).toBeNull();
});

test("cited sources alone leave no disclosure in the footer row", () => {
  const { container } = render(
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
  expect(groupChip("Ústavní soud")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /more consulted/u })).toBeNull();
  // The divider still parts the cited sources from Copy and Retry in the row.
  expect(
    container.querySelector("[data-chat-answer-citations-divider]"),
  ).not.toBeNull();
});

test("renders a case-law source without an invalid decision date", () => {
  renderInvalidDateSource();
  const disclosure = screen.getByRole("button", {
    name: "+1 more consulted",
  });
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

  // Both decisions sit under their court's chip.
  fireEvent.click(groupChip("Nejvyšší soud"));
  // The decision opens beside the chat instead of leaving for the source.
  expect(click(/4 Cdo 4\/26/u)).toBe(true);
  // A modifier click keeps the browser's own new-tab behavior.
  expect(click(/4 Cdo 4\/26/u, { metaKey: true })).toBe(false);
  // Without a decision id the row is a plain link.
  expect(click(/5 Cdo 5\/26/u)).toBe(false);
});

const provision = (anchor: string) => ({
  url: `https://my.stll.app/law/cze/statutes/99-1963-sb-obcansky-soudni-rad/v/2026-01-01#${anchor}`,
  source_url: "https://www.e-sbirka.cz/eli/cz/sb/1963/99/2026-01-01",
  anchor,
});

test("counts what the answer cites by court and by act, in the answer's words, and folds the rest", () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="cs" messages={czechMessages} timeZone="UTC">
        <FormattingProvider locale="cs" timeZone="UTC">
          <SourceChips
            messageId="grouped-answer"
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
                      "https://example.test/ns/1",
                      "21 Cdo 1/26",
                      "Nejvyšší soud",
                      "NS",
                    ),
                    hit(
                      "https://example.test/ns/2",
                      "21 Cdo 2/26",
                      "Nejvyšší soud",
                      "NS",
                    ),
                    hit(
                      "https://example.test/us/1",
                      "I. ÚS 1/26",
                      "Ústavní soud",
                      "ÚS",
                    ),
                    hit(
                      "https://example.test/ns/3",
                      "21 Cdo 3/26",
                      "Nejvyšší soud",
                      "NS",
                    ),
                    hit(
                      "https://example.test/ns/4",
                      "21 Cdo 4/26",
                      "Nejvyšší soud",
                      "NS",
                    ),
                  ],
                },
              },
              {
                type: "tool-call",
                id: "read",
                name: "infosoud_lookup_case",
                state: "complete",
                arguments: "{}",
                input: {},
                output: { items: [provision("par_240"), provision("par_241")] },
              },
              {
                type: "text",
                content: [
                  "[21 Cdo 1/26](https://example.test/ns/1),",
                  "[21 Cdo 2/26](https://example.test/ns/2),",
                  "[I. ÚS 1/26](https://example.test/us/1),",
                  "[§ 240 odst. 1 o. s. ř.](https://my.stll.app/law/cze/statutes/99-1963-sb-obcansky-soudni-rad/v/2026-01-01#par_240)",
                  "a [§ 241 o. s. ř.](https://my.stll.app/law/cze/statutes/99-1963-sb-obcansky-soudni-rad/v/2026-01-01#par_241).",
                ].join(" "),
              },
            ]}
          />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  const row = document.querySelector("[data-chat-answer-citations]");
  expect(row?.textContent).toContain("Zdroje");
  const chips = [
    ...document.querySelectorAll("[data-chat-answer-source-group]"),
  ].map((chip) => chip.textContent);
  // Highest court first, then the act under the name the answer cites it by.
  expect(chips).toEqual(["Ústavní soud1", "Nejvyšší soud2", "o. s. ř.2"]);
  expect(
    screen.getByRole("button", { name: "+2 další prověřené" }),
  ).toBeTruthy();
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
