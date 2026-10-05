import type { ComponentProps, ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

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
const { cleanup, fireEvent, render, waitFor, within } =
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

test("a rendered decision paints only CSS find ranges and Escape leaves no search marks", async () => {
  const absent = {
    reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
    type: TEXT_FIELD_TYPE.ABSENT,
  } as const;
  const decision = {
    caseNumber: "1 As 1/2026",
    caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
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
    textFields: {
      abstract: absent,
      headnote: absent,
      legalSentence: absent,
      summary: absent,
    },
  } satisfies ComponentProps<typeof DecisionText>["decision"];
  const screen = renderReaders([
    {
      content: <DecisionText decision={decision} decisionId="decision" />,
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
