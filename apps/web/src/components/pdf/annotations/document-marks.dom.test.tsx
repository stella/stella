import { createRef } from "react";
import type { ReactNode, RefObject } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { DOCUMENT_OCR_AVAILABILITY } from "@stll/api-contract/document-ocr-availability";

import type {
  DocumentMark,
  DocumentMarks,
} from "@/components/pdf/annotations/use-document-marks";
import type { PdfSelectionPassage } from "@/components/pdf/pdf-selection.logic";
import { toSafeId } from "@/lib/safe-id";
import { unregisterDomEnvironment } from "@/test-dom-environment";

import { createWebTestEnvironment } from "../../../../tests/environment.test-fixtures";

GlobalRegistrator.register({ url: "https://app.example.test/workspaces" });
const testEnvironment = createWebTestEnvironment({ file: import.meta.path });
testEnvironment.setEnvIfAbsent("VITE_API_URL", "https://api.example.test");
const { act, cleanup, fireEvent, render } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { ActionCapabilitiesProvider } =
  await import("@/lib/organization/feature-access/capability-actions");
const { resolveActionCapabilities } =
  await import("@/lib/organization/feature-access/action-capabilities.logic");
const { PDF_SELECTION_CHAT, PdfSelectionToolbar } =
  await import("@/components/pdf/pdf-selection-toolbar");
const { pdfSelectionPassage } =
  await import("@/components/pdf/pdf-selection.logic");
const { locateSelection } =
  await import("@/components/pdf/annotations/document-mark-anchor.logic");
const { DETACHED_REASON, placeMark } =
  await import("@stll/api-contract/pdf-mark-placement");
const { DOCUMENT_MARK_BOX_ATTRIBUTE, DocumentMarkBoxes } =
  await import("@/components/pdf/annotations/document-mark-boxes");
const { DocumentMarksPanel } =
  await import("@/components/pdf/annotations/document-marks-panel");

const LINE_ONE = "The seller shall";
const LINE_TWO = "deliver the goods.";
/** The same page as LibPDF reads it: the lines joined by a newline. */
const LIBPDF_PAGE = `${LINE_ONE}\n${LINE_TWO}`;
const PAGE_IDS = ["page-a"];
const FIELD_ID = "field-1";

const originalGetClientRects = Object.getOwnPropertyDescriptor(
  Range.prototype,
  "getClientRects",
);
const originalGetBoundingClientRect = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "getBoundingClientRect",
);
Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
  configurable: true,
  value: () => new DOMRect(0, 0, 800, 600),
});
Object.defineProperty(Range.prototype, "getClientRects", {
  configurable: true,
  value: () => {
    const rect = new DOMRect(20, 40, 120, 20);
    return {
      0: rect,
      length: 1,
      item: () => rect,
      [Symbol.iterator]: () => [rect][Symbol.iterator](),
    };
  },
});

afterEach(async () => {
  document.getSelection()?.removeAllRanges();
  await act(async () => cleanup());
});
afterAll(async () => {
  if (originalGetClientRects === undefined) {
    Reflect.deleteProperty(Range.prototype, "getClientRects");
  } else {
    Object.defineProperty(
      Range.prototype,
      "getClientRects",
      originalGetClientRects,
    );
  }
  if (originalGetBoundingClientRect === undefined) {
    Reflect.deleteProperty(HTMLElement.prototype, "getBoundingClientRect");
  } else {
    Object.defineProperty(
      HTMLElement.prototype,
      "getBoundingClientRect",
      originalGetBoundingClientRect,
    );
  }
  await unregisterDomEnvironment();
});

const Providers = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <ActionCapabilitiesProvider
          value={resolveActionCapabilities({
            role: "member",
            ai: true,
            deepl: false,
            ocr: DOCUMENT_OCR_AVAILABILITY.unconfigured,
            desktop: "none",
            settings: undefined,
          })}
        >
          {children}
        </ActionCapabilitiesProvider>
      </FormattingProvider>
    </IntlProvider>
  </QueryClientProvider>
);

/** One page laid out as pdf.js lays out its text layer. */
const TextLayer = ({
  rootRef,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
}) => (
  <div ref={rootRef}>
    <div data-page-id="page-a">
      <div data-text-layer="page-a">
        <span>{LINE_ONE}</span>
        <br />
        <span>{LINE_TWO}</span>
      </div>
    </div>
  </div>
);

const textNode = (container: HTMLElement, text: string): Text => {
  const node = [...container.querySelectorAll("span")].find(
    (span) => span.textContent === text,
  )?.firstChild;
  if (!(node instanceof Text)) {
    throw new TypeError(`Missing text fixture: ${text}`);
  }
  return node;
};

const selectWithin = async (
  start: Text,
  startOffset: number,
  end: Text,
  endOffset: number,
) => {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
  await act(async () => {
    document.dispatchEvent(new Event("selectionchange"));
    await new Promise((resolve) => {
      requestAnimationFrame(resolve);
    });
  });
  return range;
};

const libpdfPage = (text: string) => ({
  boxesByOffset: Array.from(text, (unit, index) =>
    unit === "\n" ? null : { x: index * 6, y: 700, width: 6, height: 12 },
  ),
  sha256: "page-digest",
  text,
});

test("a selection in the text layer becomes offsets into the page's extracted text", async () => {
  const rootRef = createRef<HTMLDivElement>();
  const view = render(<TextLayer rootRef={rootRef} />);
  const range = await selectWithin(
    textNode(view.container, LINE_ONE),
    LINE_ONE.indexOf("shall"),
    textNode(view.container, LINE_TWO),
    "deliver".length,
  );
  const root = rootRef.current ?? document.body;
  const passage = pdfSelectionPassage({
    pageNumberOf: (pageId) => PAGE_IDS.indexOf(pageId) + 1,
    range,
    root,
  });
  expect(passage?.layers).toEqual([
    {
      pageNumber: 1,
      text: "shall\ndeliver",
      before: LINE_ONE.indexOf("shall"),
      total: LINE_ONE.length + 1 + LINE_TWO.length,
    },
  ]);
  expect(
    locateSelection({
      layers: passage?.layers ?? [],
      pages: new Map([[1, libpdfPage(LIBPDF_PAGE)]]),
    }),
  ).toEqual({
    type: "located",
    spans: [
      {
        pageNumber: 1,
        startOffset: LIBPDF_PAGE.indexOf("shall"),
        endOffset: LIBPDF_PAGE.indexOf("deliver") + "deliver".length,
        quote: "shall\ndeliver",
      },
    ],
  });
});

test("the selection bar hands a highlight or a comment on the passage to the marks", async () => {
  const rootRef = createRef<HTMLDivElement>();
  const highlights: { passage: PdfSelectionPassage; color: string }[] = [];
  const comments: PdfSelectionPassage[] = [];
  const view = render(
    <Providers>
      <TextLayer rootRef={rootRef} />
      <PdfSelectionToolbar
        chat={PDF_SELECTION_CHAT.none}
        citedDocument={{
          fileFieldId: FIELD_ID,
          name: "Purchase agreement.pdf",
          reference: null,
        }}
        marking={{
          onComment: (passage) => {
            comments.push(passage);
          },
          onHighlight: (passage, { color }) => {
            highlights.push({ passage, color });
          },
        }}
        pageNumberOf={(pageId) => PAGE_IDS.indexOf(pageId) + 1}
        rootRef={rootRef}
      />
    </Providers>,
  );
  const select = async () =>
    await selectWithin(
      textNode(view.container, LINE_ONE),
      0,
      textNode(view.container, LINE_TWO),
      LINE_TWO.length,
    );

  await select();
  fireEvent.click(await view.findByRole("button", { name: "Green" }));
  expect(highlights.map(({ color }) => color)).toEqual(["green"]);
  expect(highlights.at(0)?.passage.layers.map((layer) => layer.text)).toEqual([
    `${LINE_ONE}\n${LINE_TWO}`,
  ]);

  await select();
  fireEvent.click(await view.findByRole("button", { name: "Comment" }));
  expect(comments).toHaveLength(1);
});

const markOn = (overrides: Partial<DocumentMark>): DocumentMark => {
  const startOffset = LIBPDF_PAGE.indexOf("deliver");
  const anchor = {
    endOffset: startOffset + "deliver the goods".length,
    fieldId: FIELD_ID,
    pageNumber: 1,
    pageTextSha256: "page-digest",
    quote: "deliver the goods",
    startOffset,
  };
  return {
    ...anchor,
    authorId: "user-1",
    authorImage: null,
    authorName: "Alex Novák",
    body: "Check the delivery term.",
    color: null,
    createdAt: "2026-10-20T09:00:00.000Z",
    groupId: null,
    id: toSafeId<"legalReaderAnnotation">("mark-1"),
    kind: "comment",
    mine: true,
    style: null,
    updatedAt: "2026-10-20T09:00:00.000Z",
    versionNumber: 1,
    visibility: "private",
    placement: placeMark({
      anchor,
      page: libpdfPage(LIBPDF_PAGE),
      pagesRead: true,
      viewedFieldId: FIELD_ID,
    }),
    ...overrides,
  };
};

test("a placed mark is drawn on its page, a detached one is listed with its quote, and the author removes a comment", async () => {
  const placed = markOn({});
  const detached = markOn({
    id: toSafeId<"legalReaderAnnotation">("mark-2"),
    kind: "highlight",
    body: null,
    color: "yellow",
    style: "highlight",
    quote: "within thirty days",
    versionNumber: 1,
    placement: { type: "detached", reason: "other-version" },
  });
  const removed: string[] = [];
  const marks: DocumentMarks = {
    available: true,
    marks: [placed, detached],
    create: async () => await Promise.resolve(undefined),
    locate: async () =>
      await Promise.resolve({ type: "located" as const, spans: [] }),
    remove: async (id) => {
      removed.push(id);
      await Promise.resolve(undefined);
    },
    update: async () => await Promise.resolve(undefined),
  };
  const view = render(
    <Providers>
      <div style={{ position: "relative" }}>
        <DocumentMarkBoxes
          activeId={null}
          hoveredId={null}
          marks={marks.marks}
          pageNumber={1}
          viewport={{
            convertToViewportPoint: (x: number, y: number) => [x * 2, 1000 - y],
          }}
        />
      </div>
      <DocumentMarksPanel
        activeId={null}
        composing={null}
        marks={marks}
        onActivate={() => undefined}
        onClose={() => undefined}
        onComposed={() => undefined}
      />
    </Providers>,
  );

  const boxes = view.container.querySelectorAll<HTMLElement>(
    `[${DOCUMENT_MARK_BOX_ATTRIBUTE}]`,
  );
  // The placed comment only: the detached highlight has no place to be drawn.
  expect(
    [...boxes].map((box) => box.getAttribute(DOCUMENT_MARK_BOX_ATTRIBUTE)),
  ).toEqual(["mark-1"]);
  expect(boxes.item(0).style.left).toBe(
    `${String(LIBPDF_PAGE.indexOf("deliver") * 6 * 2)}px`,
  );

  expect(view.getByText("Check the delivery term.")).toBeTruthy();
  expect(view.getByText("Not on this version")).toBeTruthy();
  expect(view.getByText("within thirty days")).toBeTruthy();
  expect(
    view.getByText("Made on version 1; the page now reads differently."),
  ).toBeTruthy();

  const remove = view.getAllByRole("button", { name: "Delete" }).at(0);
  expect(remove).toBeDefined();
  if (remove !== undefined) {
    fireEvent.click(remove);
  }
  expect(removed).toEqual(["mark-1"]);
});

test("a mark that keeps its first page lists the page it lost, with the mark's words", () => {
  const group = "group-1";
  const first = markOn({
    groupId: group,
    id: toSafeId<"legalReaderAnnotation">("mark-a"),
  });
  const lost = markOn({
    body: null,
    groupId: group,
    id: toSafeId<"legalReaderAnnotation">("mark-b"),
    pageNumber: 2,
    quote: "within thirty days",
    placement: { type: "detached", reason: DETACHED_REASON.textChanged },
  });
  const marks: DocumentMarks = {
    available: true,
    marks: [first, lost],
    create: async () => await Promise.resolve(undefined),
    locate: async () =>
      await Promise.resolve({ type: "located" as const, spans: [] }),
    remove: async () => await Promise.resolve(undefined),
    update: async () => await Promise.resolve(undefined),
  };
  const view = render(
    <Providers>
      <DocumentMarksPanel
        activeId={null}
        composing={null}
        marks={marks}
        onActivate={() => undefined}
        onClose={() => undefined}
        onComposed={() => undefined}
      />
    </Providers>,
  );

  expect(view.getByText("Not on this version")).toBeTruthy();
  expect(view.getByText("within thirty days")).toBeTruthy();
  expect(view.getByText("The words are no longer on page 2.")).toBeTruthy();
  // The placed comment and the lost page's entry both carry its words.
  expect(view.getAllByText("Check the delivery term.")).toHaveLength(2);
});
