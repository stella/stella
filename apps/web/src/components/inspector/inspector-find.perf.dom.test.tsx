/**
 * What a find in a reader costs, counted at two document sizes.
 *
 * Every reader that searches its text does it through `useInspectorFind`, so
 * the hosts are enumerated from the source: each module that calls the hook
 * names the text it renders, and that text is measured here at N and 10N
 * paragraphs. A keystroke, a step and a scroll must cost the same at both
 * sizes; only reading the text (once per version of it) may grow with it.
 *
 * The counts are deterministic: text nodes walked, DOM ranges made, and
 * characters folded through `String.prototype.normalize`.
 */

import type { ComponentProps, ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { DocumentAst } from "@stll/legal-ast/document-ast";
import { E_SBIRKA_LIST_SCHEME } from "@stll/legal-ast/statute-list";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });

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
Object.defineProperty(globalThis, "CSS", {
  configurable: true,
  value: readerCss,
});
Object.defineProperty(globalThis, "Highlight", {
  configurable: true,
  value: ReaderHighlight,
});

/** Blocks on screen at once, and how far one scroll step moves. */
const VISIBLE_BLOCKS = 8;

/** The paragraph-level elements a find draws per block, in document order. */
const BLOCK_SELECTOR =
  "p, li, dt, dd, h1, h2, h3, h4, h5, h6, td, th, blockquote, pre, figcaption";

/**
 * A viewport over the reader's blocks: the first visible block moves by
 * whole blocks, and each observer hears, like a browser's, an entry for
 * every target on observe and then only for targets whose visibility
 * changed.
 */
const viewport = { first: 0, order: new Map<Element, number>() };
const isOnScreen = (target: Element): boolean => {
  const position = viewport.order.get(target);
  return (
    position !== undefined &&
    position >= viewport.first &&
    position < viewport.first + VISIBLE_BLOCKS
  );
};
const liveObservers = new Set<ViewportObserver>();
class ViewportObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "0px";
  readonly scrollMargin = "0px";
  readonly thresholds = [0];
  private readonly callback: IntersectionObserverCallback;
  private readonly reported = new Map<Element, boolean | null>();
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    liveObservers.add(this);
  }
  observe(target: Element) {
    this.reported.set(target, null);
    queueMicrotask(() => {
      this.report();
    });
  }
  report() {
    const entries: IntersectionObserverEntry[] = [];
    for (const [target, last] of this.reported) {
      const visible = isOnScreen(target);
      if (last === visible) {
        continue;
      }
      this.reported.set(target, visible);
      const rect = target.getBoundingClientRect();
      entries.push({
        boundingClientRect: rect,
        intersectionRatio: visible ? 1 : 0,
        intersectionRect: rect,
        isIntersecting: visible,
        rootBounds: null,
        target,
        time: 0,
      });
    }
    if (entries.length > 0) {
      this.callback(entries, this);
    }
  }
  disconnect() {
    liveObservers.delete(this);
    this.reported.clear();
  }
  takeRecords() {
    return [];
  }
  unobserve(target: Element) {
    this.reported.delete(target);
  }
}
Object.defineProperty(globalThis, "IntersectionObserver", {
  configurable: true,
  value: ViewportObserver,
});

/** The counted work. */
const counts = { normalized: 0, ranges: 0, walked: 0 };
const resetCounts = () => {
  counts.normalized = 0;
  counts.ranges = 0;
  counts.walked = 0;
};
const createTreeWalker = document.createTreeWalker.bind(document);
document.createTreeWalker = (...args: Parameters<typeof createTreeWalker>) => {
  const walker = createTreeWalker(...args);
  const nextNode = walker.nextNode.bind(walker);
  walker.nextNode = () => {
    const node = nextNode();
    if (node !== null) {
      counts.walked += 1;
    }
    return node;
  };
  return walker;
};
const createRange = document.createRange.bind(document);
document.createRange = () => {
  counts.ranges += 1;
  return createRange();
};
const nativeNormalize = Object.getOwnPropertyDescriptor(
  String.prototype,
  "normalize",
);
const normalize = String.prototype.normalize;
// oxlint-disable-next-line no-extend-native -- counts the folding a find does; the native method is restored after the file.
Object.defineProperty(String.prototype, "normalize", {
  configurable: true,
  value: function value(this: string, form?: string) {
    counts.normalized += 1;
    return normalize.call(this, form);
  },
  writable: true,
});

const { useMemo, useRef } = await import("react");
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { WebReaderPresentationProvider } =
  await import("@/components/legal-reader/web-reader-presentation");
const { InspectorFindBar, useInspectorFind } = await import("./inspector-find");
const { WebDecisionReader } =
  await import("@/components/legal-reader/web-decision-reader");
const { StatuteText } =
  await import("@/features/statutes/components/statute-text");
const { toSafeId } = await import("@/lib/safe-id");
const { TEXT_ABSENCE_REASON, TEXT_FIELD_TYPE } =
  await import("@stll/api-contract/case-law-text-field");
const { DECISION_IDENTIFIER_TYPES } =
  await import("@stll/legal-ast/decision-identifier");
const messages = (await import("@/i18n/langs/en.json")).default;

afterEach(() => {
  cleanup();
  highlights.clear();
  liveObservers.clear();
  viewport.first = 0;
  viewport.order = new Map();
});
afterAll(async () => {
  if (nativeNormalize !== undefined) {
    // oxlint-disable-next-line no-extend-native -- restores the native method replaced above.
    Object.defineProperty(String.prototype, "normalize", nativeNormalize);
  }
  await unregisterDomEnvironment();
});

/** Every paragraph holds one word the query reaches. */
const paragraphText = (index: number) =>
  `Odpovědnosti za škodu v bodě ${String(index)} se nelze vyhnout.`;

const paragraphs = (count: number): DocumentAst["blocks"] =>
  Array.from({ length: count }, (_, index) => ({
    anchorId: `p-${String(index)}`,
    id: `b${String(index)}`,
    inlines: [{ text: paragraphText(index), type: "text" as const }],
    plainText: paragraphText(index),
    type: "paragraph" as const,
  }));

const decisionOf = (blocks: DocumentAst["blocks"]) => {
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
    documentAst: {
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
    },
    documentPending: false,
    documentReadFailed: false,
    textState: null,
    documentUnavailable: false,
    fulltext: null,
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
  } satisfies ComponentProps<typeof WebDecisionReader>["decision"];
};

/** The texts a reader host renders, each drawn at a given length. */
const READER_TEXTS = {
  decision: (count: number) => (
    <WebDecisionReader
      decision={decisionOf(paragraphs(count))}
      decisionId="decision"
      isHydrated
      surface="development"
    />
  ),
  statute: (count: number) => (
    <StatuteText
      annotationAnchors={[]}
      blocks={paragraphs(count)}
      citationWork={null}
      documentId="statute"
      fulltext={null}
      language="cs"
      masthead={null}
      provisionCitationCounts={new Map()}
      statuteLists={E_SBIRKA_LIST_SCHEME}
      statuteTitle="Zákon"
      versionCount={1}
      versionValidFrom={null}
    />
  ),
} as const satisfies Record<string, (count: number) => ReactNode>;
type ReaderTextKind = keyof typeof READER_TEXTS;

const SOURCE_ROOT = path.resolve(import.meta.dirname, "../..");

/** Every module that searches a reader's text, and the text it renders. */
const FIND_HOSTS = {
  "components/inspector/external-reference-panel.tsx": null,
  "features/case-law/components/case-decision-inspector-view.tsx": "decision",
  "features/statutes/components/provision-inspector-view.tsx": "statute",
  "features/statutes/components/statute-inspector-view.tsx": "statute",
  "routes/law/-case-detail.tsx": "decision",
  "routes/law/-statute-detail.tsx": "statute",
} as const satisfies Record<string, ReaderTextKind | null>;

/**
 * Hosts whose text is not a document rendered block by block. Shrink-only:
 * an entry whose host now renders one of the texts above, or no longer
 * searches at all, fails the census.
 */
const NOT_A_DOCUMENT_LEDGER: Readonly<Record<string, string>> = {
  "components/inspector/external-reference-panel.tsx":
    "an external page's preview: one fetched excerpt, capped by the preview endpoint, not a reader document",
};

const findHostModules = (): string[] =>
  [...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: SOURCE_ROOT })]
    .filter(
      (file) =>
        !file.includes(".test.") &&
        file !== "components/inspector/inspector-find.tsx" &&
        /\buseInspectorFind\(/u.test(
          readFileSync(path.join(SOURCE_ROOT, file), "utf-8"),
        ),
    )
    .toSorted();

type FindCost = typeof counts;
type ReaderCosts = {
  /** Reading the text: once per version of it. */
  open: FindCost;
  keystroke: FindCost;
  step: FindCost;
  scroll: FindCost;
  /** Marks drawn after the scroll. */
  drawnAfterScroll: number;
};

const snapshot = (): FindCost => ({ ...counts });

const Reader = ({ kind, count }: { kind: ReaderTextKind; count: number }) => {
  const panelRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const find = useInspectorFind({
    contentRef,
    enabled: true,
    highlightKey: "perf",
    initialQuery: "odpovědn",
    panelRef,
  });
  // The hosts compile with the React Compiler, which keeps the text's element
  // while only the find's state changes; this test file does not compile, so
  // it keeps the element by hand.
  const text = useMemo(() => READER_TEXTS[kind](count), [count, kind]);
  return (
    <section aria-label="reader" ref={panelRef}>
      <InspectorFindBar find={find} />
      <div data-testid="content" ref={contentRef}>
        {text}
      </div>
    </section>
  );
};

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

const matchCounter = (current: number, total: number) =>
  messages.folio.findReplace.matchCounter
    .replace("{current}", () => String(current))
    .replace("{total}", () => String(total));

const measure = async (
  kind: ReaderTextKind,
  count: number,
): Promise<ReaderCosts> => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  resetCounts();
  const screen = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <WebReaderPresentationProvider>
            <Reader count={count} kind={kind} />
          </WebReaderPresentationProvider>
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  const content = screen.getByTestId("content");
  viewport.order = new Map(
    [...content.querySelectorAll(BLOCK_SELECTOR)].map((block, index) => [
      block,
      index,
    ]),
  );
  for (const observer of liveObservers) {
    observer.report();
  }
  await waitFor(() =>
    expect(screen.getByText(matchCounter(1, count))).toBeTruthy(),
  );
  await settle();
  const open = snapshot();

  resetCounts();
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "odpovědnost" },
  });
  await settle();
  expect(screen.getByText(matchCounter(1, count))).toBeTruthy();
  const keystroke = snapshot();

  resetCounts();
  fireEvent.click(
    screen.getByRole("button", { name: messages.common.nextMatch }),
  );
  await settle();
  expect(screen.getByText(matchCounter(2, count))).toBeTruthy();
  const step = snapshot();

  resetCounts();
  viewport.first += VISIBLE_BLOCKS;
  await act(async () => {
    for (const observer of liveObservers) {
      observer.report();
    }
    await Promise.resolve();
  });
  const scroll = snapshot();
  const drawnAfterScroll = highlights.get("stella-inspector-find-perf")?.size;

  // The whole document stays in reach: Previous from the first match lands
  // on the last paragraph, far below the screen.
  fireEvent.click(
    screen.getByRole("button", { name: messages.common.previousMatch }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: messages.common.previousMatch }),
  );
  await settle();
  expect(screen.getByText(matchCounter(count, count))).toBeTruthy();
  const active = [
    ...(highlights.get("stella-inspector-find-active-perf") ?? []),
  ].at(0);
  expect(active?.startContainer.parentElement?.textContent).toContain(
    paragraphText(count - 1),
  );

  cleanup();
  return {
    drawnAfterScroll: drawnAfterScroll ?? 0,
    keystroke,
    open,
    scroll,
    step,
  };
};

const SMALL = 30;
const LARGE = SMALL * 10;

describe("reader find cost", () => {
  test("every module that searches a reader's text is measured or ledgered", () => {
    expect(findHostModules()).toEqual(Object.keys(FIND_HOSTS).toSorted());
    for (const [file, kind] of Object.entries(FIND_HOSTS)) {
      expect({ file, ledgered: file in NOT_A_DOCUMENT_LEDGER }).toEqual({
        file,
        ledgered: kind === null,
      });
    }
    // A ledger entry for a module that no longer hosts a find is stale.
    expect(
      Object.keys(NOT_A_DOCUMENT_LEDGER).filter(
        (file) => !Object.hasOwn(FIND_HOSTS, file),
      ),
    ).toEqual([]);
  });

  const kinds = [
    ...new Set(
      Object.values(FIND_HOSTS).filter(
        (kind): kind is ReaderTextKind => kind !== null,
      ),
    ),
  ].toSorted();

  test.each(kinds)(
    "%s: a keystroke, a step and a scroll cost the same at N and 10N paragraphs",
    async (kind) => {
      const small = await measure(kind, SMALL);
      const large = await measure(kind, LARGE);

      // Reading the text is the one cost that follows its length.
      expect(large.open.walked).toBeGreaterThan(small.open.walked);

      // A keystroke queries the reading: no walk, no folding of the text,
      // and marks only for what is on screen plus the active match.
      for (const { keystroke } of [small, large]) {
        expect(keystroke.walked).toBe(0);
        expect(keystroke.ranges).toBeLessThanOrEqual(VISIBLE_BLOCKS + 1);
      }
      expect(large.keystroke.normalized).toBe(small.keystroke.normalized);

      // A step moves the active mark and nothing else.
      expect(small.step).toEqual({ normalized: 0, ranges: 1, walked: 0 });
      expect(large.step).toEqual(small.step);

      // A scroll draws the blocks that came on screen and drops the rest.
      expect(small.scroll).toEqual({
        normalized: 0,
        ranges: VISIBLE_BLOCKS,
        walked: 0,
      });
      expect(large.scroll).toEqual(small.scroll);
      expect(small.drawnAfterScroll).toBe(VISIBLE_BLOCKS);
      expect(large.drawnAfterScroll).toBe(VISIBLE_BLOCKS);
    },
  );
});
