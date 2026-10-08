import type { ComponentProps, ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });

// Happy DOM has ranges but no CSS Custom Highlight API. Keep its real ranges
// so assertions exercise the text and offsets the reader would paint.
class ReaderHighlight extends Set<Range> {
  constructor(...ranges: Range[]) {
    super(ranges);
  }
}
const highlights = new Map<string, ReaderHighlight>();
const readerCss = CSS;
Object.defineProperty(readerCss, "highlights", {
  configurable: true,
  value: highlights,
});
// Happy DOM creates a new CSS object on each getter access; a browser retains
// one registry across all readers and every render.
Object.defineProperty(globalThis, "CSS", {
  configurable: true,
  value: readerCss,
});
Object.defineProperty(globalThis, "Highlight", {
  configurable: true,
  value: ReaderHighlight,
});

const { useRef } = await import("react");
const { act, cleanup, fireEvent, render, waitFor, within } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { InspectorFindBar, useInspectorFind } = await import("./inspector-find");
const { DecisionText } =
  await import("@/features/case-law/components/case-viewer/decision-text");
const { toSafeId } = await import("@/lib/safe-id");
const { TEXT_ABSENCE_REASON, TEXT_FIELD_TYPE } =
  await import("@stll/api-contract/case-law-text-field");
const { DECISION_IDENTIFIER_TYPES } =
  await import("@stll/legal-ast/decision-identifier");
const messages = (await import("@/i18n/langs/en.json")).default;

afterEach(() => {
  cleanup();
  highlights.clear();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const readerText = {
  prefix: "Odpověd",
  suffix: "nosti",
  firstEnding: " se nelze vyhnout.",
  liabilityParagraph: "Pravidla odpovědnosti za škodu.",
  damagesParagraph: "Náhrada škody je samostatný nárok.",
};

type ReaderOptions = {
  content?: ReactNode;
  enabled?: boolean;
  initialQuery?: string;
  name: string;
};
const Reader = ({
  content,
  enabled = true,
  initialQuery,
  name,
}: ReaderOptions) => {
  const panelRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const find = useInspectorFind({
    contentRef,
    enabled,
    highlightKey: name,
    initialQuery,
    panelRef,
  });
  return (
    <section aria-label={name} ref={panelRef}>
      <InspectorFindBar find={find} />
      <div ref={contentRef}>
        {content === undefined ? (
          <>
            <p>
              <span>{readerText.prefix}</span>
              <strong>{readerText.suffix}</strong>
              {readerText.firstEnding}
            </p>
            <p>{readerText.liabilityParagraph}</p>
            <p>{readerText.damagesParagraph}</p>
          </>
        ) : (
          content
        )}
      </div>
    </section>
  );
};

const renderReaders = (readers: ReaderOptions[]) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = (options: ReaderOptions[]) => (
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        {options.map((reader) => (
          <Reader key={reader.name} {...reader} />
        ))}
      </IntlProvider>
    </QueryClientProvider>
  );
  const screen = render(view(readers));
  return {
    ...screen,
    rerenderReaders: (options: ReaderOptions[]) =>
      screen.rerender(view(options)),
  };
};

const highlightText = (name: string) =>
  [...(highlights.get(name) ?? [])].map((range) => range.toString());
const activeRange = (name: string) =>
  [...(highlights.get(`stella-inspector-find-active-${name}`) ?? [])].at(0);
const matchCounter = (current: number, total: number) =>
  messages.folio.findReplace.matchCounter
    .replace("{current}", () => String(current))
    .replace("{total}", () => String(total));

const textDecision = (overrides: { documentAst?: DocumentAst } = {}) => {
  const absent = {
    reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
    type: TEXT_FIELD_TYPE.ABSENT,
  } as const;
  return {
    caseNumber: "1 As 1/2026",
    caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
    country: "CZE",
    court: "Test court",
    courtAbbreviation: null,
    courtTier: "other",
    documentAst: null,
    documentPending: false,
    documentReadFailed: false,
    documentUnavailable: false,
    fulltext: "Odpovědnosti za škodu se nelze vyhnout.",
    id: toSafeId<"caseLawDecision">("9b1f0f3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"),
    judges: [],
    language: "cs",
    sourceAttributionUrl: null,
    ...overrides,
    textFields: {
      abstract: absent,
      headnote: absent,
      legalSentence: absent,
      summary: absent,
    },
  } satisfies ComponentProps<typeof DecisionText>["decision"];
};

test("a rendered decision paints only CSS find ranges and Escape leaves no search marks", async () => {
  const decision = textDecision();
  const screen = renderReaders([
    {
      content: (
        <DecisionText
          surface="development"
          decision={decision}
          decisionId="decision"
        />
      ),
      initialQuery: "odpovědnost",
      name: "decision",
    },
  ]);
  await waitFor(() =>
    expect(highlightText("stella-inspector-find-decision")).toEqual([
      "Odpovědnosti",
    ]),
  );
  expect(screen.getByText(matchCounter(1, 1))).toBeTruthy();
  expect(
    screen.container.querySelector("mark, [data-reader-match-index]"),
  ).toBeNull();
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("searchbox")).toBeNull());
  expect(highlights.size).toBe(0);
  expect(
    screen.container.querySelector("mark, [data-reader-match-index]"),
  ).toBeNull();
  expect(screen.getByText(decision.fulltext)).toBeTruthy();
});

test("search terms open the bar and navigate morphology matches across inline markup", async () => {
  const screen = renderReaders([
    { initialQuery: "odpovědnost", name: "decision" },
  ]);
  const input = screen.getByRole("searchbox", {
    name: messages.folio.findReplace.findText,
  });
  expect(input.getAttribute("value")).toBe("odpovědnost");
  await waitFor(() =>
    expect(screen.getByText(matchCounter(1, 2))).toBeTruthy(),
  );
  expect(highlightText("stella-inspector-find-decision")).toEqual([
    "Odpovědnosti",
    "odpovědnosti",
  ]);
  const first = activeRange("decision");
  expect(first?.startContainer.textContent).toBe("Odpověd");
  expect(first?.endContainer.textContent).toBe("nosti");
  fireEvent.click(
    screen.getByRole("button", { name: messages.common.nextMatch }),
  );
  await waitFor(() =>
    expect(screen.getByText(matchCounter(2, 2))).toBeTruthy(),
  );
  expect(activeRange("decision")?.startContainer).not.toBe(
    first?.startContainer,
  );
  expect(activeRange("decision")?.toString()).toBe("odpovědnosti");
  fireEvent.click(
    screen.getByRole("button", { name: messages.common.previousMatch }),
  );
  await waitFor(() =>
    expect(screen.getByText(matchCounter(1, 2))).toBeTruthy(),
  );
  expect(activeRange("decision")?.startContainer).toBe(first?.startContainer);
});

test("typing replaces search terms and Escape removes every reader highlight", async () => {
  const screen = renderReaders([
    { initialQuery: "odpovědnost", name: "statute" },
  ]);
  await waitFor(() =>
    expect(highlightText("stella-inspector-find-statute")).toHaveLength(2),
  );
  const input = screen.getByRole("searchbox", {
    name: messages.folio.findReplace.findText,
  });
  fireEvent.change(input, { target: { value: "náhrada" } });
  await waitFor(() =>
    expect(highlightText("stella-inspector-find-statute")).toEqual(["Náhrada"]),
  );
  expect(activeRange("statute")?.toString()).toBe("Náhrada");
  expect(screen.getByText(matchCounter(1, 1))).toBeTruthy();
  fireEvent.keyDown(input, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("searchbox")).toBeNull());
  expect([...highlights.keys()]).toEqual([]);
});

test("closing one reader clears its highlights while the neighboring reader retains its query", async () => {
  const screen = renderReaders([
    { initialQuery: "odpovědnost", name: "decision" },
    { initialQuery: "náhrada", name: "statute" },
  ]);
  await waitFor(() => expect(highlights.size).toBe(4));
  const decision = within(screen.getByRole("region", { name: "decision" }));
  const statute = within(screen.getByRole("region", { name: "statute" }));
  fireEvent.click(
    decision.getByRole("button", { name: messages.folio.findReplace.close }),
  );
  await waitFor(() => expect(decision.queryByRole("searchbox")).toBeNull());
  expect(highlights.has("stella-inspector-find-decision")).toBe(false);
  expect(highlights.has("stella-inspector-find-active-decision")).toBe(false);
  expect(statute.getByRole("searchbox").getAttribute("value")).toBe("náhrada");
  expect(highlightText("stella-inspector-find-statute")).toEqual(["Náhrada"]);
  expect(activeRange("statute")?.toString()).toBe("Náhrada");
});

test("opening without search terms keeps the bar closed until the reader receives Find", async () => {
  const screen = renderReaders([{ name: "decision" }]);
  expect(screen.queryByRole("searchbox")).toBeNull();
  expect(highlights.size).toBe(0);
  const pane = screen.getByRole("region", { name: "decision" });
  // Happy DOM cannot lay out a visible pane. Supply the browser's visibility
  // boundary to the real find ownership registry, rather than bypassing it.
  Object.defineProperty(pane, "offsetParent", { value: document.body });
  fireEvent.keyDown(pane, { key: "f", code: "KeyF", ctrlKey: true });
  await waitFor(() => expect(screen.getByRole("searchbox")).toBeTruthy());
  expect(screen.getByRole("searchbox").getAttribute("value")).toBe("");
  expect(highlights.size).toBe(0);
});

test("Escape inside one pane leaves its neighbor's find bar and highlights intact", async () => {
  const screen = renderReaders([
    { initialQuery: "odpovědnost", name: "decision" },
    { initialQuery: "náhrada", name: "statute" },
  ]);
  await waitFor(() => expect(highlights.size).toBe(4));
  const decision = within(screen.getByRole("region", { name: "decision" }));
  const statute = within(screen.getByRole("region", { name: "statute" }));
  fireEvent.keyDown(decision.getByRole("searchbox"), { key: "Escape" });
  await waitFor(() => expect(decision.queryByRole("searchbox")).toBeNull());
  expect(highlights.has("stella-inspector-find-decision")).toBe(false);
  expect(highlights.has("stella-inspector-find-active-decision")).toBe(false);
  expect(statute.getByRole("searchbox").getAttribute("value")).toBe("náhrada");
  expect(highlightText("stella-inspector-find-statute")).toEqual(["Náhrada"]);
  expect(activeRange("statute")?.toString()).toBe("Náhrada");
});

test("an initial search query survives while the reader waits for its text", async () => {
  const screen = renderReaders([
    {
      content: null,
      enabled: false,
      initialQuery: "odpovědnost",
      name: "decision",
    },
  ]);
  expect(highlights.size).toBe(0);
  screen.rerenderReaders([
    {
      enabled: true,
      initialQuery: "odpovědnost",
      name: "decision",
    },
  ]);
  await waitFor(() =>
    expect(highlightText("stella-inspector-find-decision")).toEqual([
      "Odpovědnosti",
      "odpovědnosti",
    ]),
  );
  expect(screen.getByRole("searchbox").getAttribute("value")).toBe(
    "odpovědnost",
  );
  expect(screen.getByText(matchCounter(1, 2))).toBeTruthy();
});

const readerAst = (blocks: DocumentAst["blocks"]) =>
  ({
    blocks,
    metadata: {
      caseNumber: "1 As 1/2026",
      court: "Test court",
      decisionDate: null,
      decisionType: "Judgment",
      ecli: null,
      keywords: [],
      statutes: [],
    },
    source: { documentId: "1", printUrl: "", system: "test", webUrl: "" },
    version: 1,
  }) satisfies DocumentAst;

test("a letter-spaced heading still marks a find for the collapsed word", async () => {
  const spaced = "O d ů v o d n ě n í :";
  const screen = renderReaders([
    {
      content: (
        <DecisionText
          surface="development"
          decision={textDecision({
            documentAst: readerAst([
              {
                anchorId: "p-1",
                id: "b1",
                inlines: [{ text: spaced, type: "text" }],
                level: 2,
                plainText: spaced,
                type: "heading",
              },
            ]),
          })}
          decisionId="decision"
        />
      ),
      initialQuery: "odůvodnění",
      name: "decision",
    },
  ]);
  expect(
    screen.container.querySelectorAll('[data-reader-elided="letter-spacing"]'),
  ).toHaveLength(10);
  await waitFor(() =>
    expect(screen.getByText(matchCounter(1, 1))).toBeTruthy(),
  );
  const range = activeRange("decision");
  expect(range).toBeDefined();
  const drawn = range?.cloneContents();
  for (const elided of drawn?.querySelectorAll("[data-reader-elided]") ?? []) {
    elided.remove();
  }
  expect(drawn?.textContent).toBe("Odůvodnění");
});

test("a run-on caption still marks a find inside a caption line", async () => {
  const caption = [
    "\n",
    "ČESKÉ REPUBLIKY\t              21 Cdo 1484/2004",
    " ",
    "\n",
    "ČESKÁ REPUBLIKA ",
    " ",
    "\n",
    "ROZSUDEK",
    " ",
    "\n",
    "JMÉNEM REPUBLIKY",
  ];
  const screen = renderReaders([
    {
      content: (
        <DecisionText
          surface="development"
          decision={textDecision({
            documentAst: readerAst([
              {
                anchorId: "p-1",
                id: "b1",
                inlines: [{ text: "NEJVYŠŠÍ SOUD", type: "text" }],
                plainText: "NEJVYŠŠÍ SOUD",
                type: "paragraph",
              },
              {
                anchorId: "p-2",
                id: "b2",
                inlines: caption.map((text) => ({ text, type: "text" })),
                plainText:
                  "ČESKÉ REPUBLIKY\t 21 Cdo 1484/2004 ČESKÁ REPUBLIKA ROZSUDEK JMÉNEM REPUBLIKY",
                type: "paragraph",
              },
              {
                anchorId: "p-3",
                id: "b3",
                inlines: [
                  {
                    text: "Nejvyšší soud České republiky rozhodl takto:",
                    type: "text",
                  },
                ],
                plainText: "Nejvyšší soud České republiky rozhodl takto:",
                type: "paragraph",
              },
            ]),
          })}
          decisionId="decision"
        />
      ),
      initialQuery: "ROZSUDEK",
      name: "decision",
    },
  ]);
  await waitFor(() =>
    expect(screen.getByText(matchCounter(1, 1))).toBeTruthy(),
  );
  expect(highlightText("stella-inspector-find-decision")).toEqual(["ROZSUDEK"]);
  expect(
    activeRange("decision")?.startContainer.parentElement?.closest("h1"),
  ).toBe(screen.container.querySelector("header h1"));
});

const HARD_WRAPPED_LINES = [
  "Stěžovatel se ústavní stížností, která splňuje formální náležitosti",
  "stanovené zákonem č. 182/1993 Sb., o Ústavním soudu, domáhal zrušení",
  "v záhlaví uvedeného rozsudku, neboť podle jeho názoru jím obecné",
  "soudy porušily jeho základní právo na spravedlivý proces zaručené",
  "čl. 36 odst. 1 Listiny základních práv a svobod. Krajský soud podle",
  "stěžovatele nepřihlédl k důkazům, které navrhl, a své rozhodnutí",
  "řádně neodůvodnil, ačkoli tak byl povinen učinit podle ustanovení",
  "§ 157 odst. 2 občanského soudního řádu.",
  "Ústavní soud si vyžádal spis a vyjádření účastníků řízení. Krajský",
  "soud ve svém vyjádření uvedl, že poměry stěžovatele posoudil podle",
  "ustálené judikatury a v souladu se zákonem.",
];

test("a hard-wrapped decision finds words inside both drawn paragraphs", async () => {
  const screen = renderReaders([
    {
      content: (
        <DecisionText
          surface="development"
          decision={textDecision({
            documentAst: readerAst(
              HARD_WRAPPED_LINES.map((text, index) => ({
                anchorId: `p-${String(index)}`,
                id: `b${String(index)}`,
                inlines: [{ text, type: "text" }],
                plainText: text,
                type: "paragraph",
              })),
            ),
          })}
          decisionId="decision"
        />
      ),
      initialQuery: "Krajský",
      name: "decision",
    },
  ]);
  await waitFor(() =>
    expect(screen.getByText(matchCounter(1, 2))).toBeTruthy(),
  );
  expect(highlightText("stella-inspector-find-decision")).toEqual([
    "Krajský",
    "Krajský",
  ]);
});

/**
 * Records every move to a match. Happy DOM has no scroller around the
 * reader, so each one lands in the element's own scrollIntoView.
 */
const recordScrolls = () => {
  const scrolledTo: string[] = [];
  const own = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollIntoView",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value(this: HTMLElement) {
      scrolledTo.push(this.textContent);
    },
  });
  const restore = () => {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    if (own !== undefined) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", own);
    }
  };
  return { restore, scrolledTo };
};

test("Next and Previous take the reader back to a lone match, while repaints leave the view alone", async () => {
  const { restore, scrolledTo } = recordScrolls();
  try {
    const screen = renderReaders([
      { initialQuery: "samostatný", name: "decision" },
    ]);
    await waitFor(() =>
      expect(screen.getByText(matchCounter(1, 1))).toBeTruthy(),
    );
    await waitFor(() => expect(scrolledTo).toHaveLength(1));

    // The text changing under the open bar repaints the marks only.
    const text =
      screen.getByText(readerText.damagesParagraph).parentElement ??
      panic("The reader did not render its text");
    const note = text.ownerDocument.createElement("p");
    note.textContent = "Poznámka pod textem.";
    text.append(note);
    await act(async () => {
      await sleep(0);
    });
    expect(scrolledTo).toHaveLength(1);

    // The reader has scrolled away; each explicit step returns to the match,
    // though it stays the first of one.
    for (const name of [
      messages.common.nextMatch,
      messages.common.previousMatch,
    ]) {
      const before = scrolledTo.length;
      fireEvent.click(screen.getByRole("button", { name }));
      await waitFor(() => expect(scrolledTo).toHaveLength(before + 1));
      expect(scrolledTo.at(-1)).toBe(readerText.damagesParagraph);
      expect(screen.getByText(matchCounter(1, 1))).toBeTruthy();
    }
  } finally {
    restore();
  }
});

test("removing the active match from the text moves the active mark but not the view", async () => {
  const { restore, scrolledTo } = recordScrolls();
  try {
    const screen = renderReaders([
      { initialQuery: "odpovědnost", name: "decision" },
    ]);
    await waitFor(() =>
      expect(screen.getByText(matchCounter(1, 2))).toBeTruthy(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: messages.common.nextMatch }),
    );
    await waitFor(() =>
      expect(screen.getByText(matchCounter(2, 2))).toBeTruthy(),
    );
    expect(scrolledTo.at(-1)).toBe(readerText.liabilityParagraph);
    const scrolls = scrolledTo.length;

    // A toggle in the text takes the paragraph with the active match away;
    // the remaining match becomes active where it already is on screen.
    screen.getByText(readerText.liabilityParagraph).remove();
    await waitFor(() =>
      expect(screen.getByText(matchCounter(1, 1))).toBeTruthy(),
    );
    await act(async () => {
      await sleep(0);
    });
    expect(activeRange("decision")?.toString()).toBe("Odpovědnosti");
    expect(scrolledTo).toHaveLength(scrolls);

    // Asking for the next match still takes the reader there.
    fireEvent.click(
      screen.getByRole("button", { name: messages.common.nextMatch }),
    );
    await waitFor(() => expect(scrolledTo).toHaveLength(scrolls + 1));
  } finally {
    restore();
  }
});
