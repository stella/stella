import { createRef } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";

import { DOCUMENT_OCR_AVAILABILITY } from "@stll/api-contract/document-ocr-availability";

import { unregisterDomEnvironment } from "@/test-dom-environment";

import { createWebTestEnvironment } from "../../../tests/environment.test-fixtures";

GlobalRegistrator.register({ url: "https://app.example.test/workspaces" });
const testEnvironment = createWebTestEnvironment({ file: import.meta.path });
testEnvironment.setEnvIfAbsent("VITE_API_URL", "https://api.example.test");
const { act, cleanup, fireEvent, render } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { composerText } = await import("@/components/chat-editor-source");
const { useInspectorCommandStore } =
  await import("@/components/inspector/inspector-command-store");
const { ActionCapabilitiesProvider } =
  await import("@/lib/organization/feature-access/capability-actions");
const { resolveActionCapabilities } =
  await import("@/lib/organization/feature-access/action-capabilities.logic");
const { PDF_SELECTION_CHAT, PdfSelectionToolbar } =
  await import("./pdf-selection-toolbar");

const { EOC_CLASS_NAME } = await import("@/lib/pdf/consts");

const FILE_FIELD_ID = "field-1";
const LINE_ONE = "The seller shall";
const LINE_TWO = "deliver the goods.";
const OVERLAY_LABEL = "Overlay label";
const PAGE_TWO_TEXT = "Payment is due on delivery.";
const PAGE_IDS = ["page-a", "page-b"];

const originalGetClientRects = Object.getOwnPropertyDescriptor(
  Range.prototype,
  "getClientRects",
);
const originalGetBoundingClientRect = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "getBoundingClientRect",
);
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
Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
  configurable: true,
  value: () => new DOMRect(0, 0, 800, 600),
});

let clipboardWrites: string[] = [];
beforeEach(() => {
  clipboardWrites = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        clipboardWrites.push(text);
      },
    },
  });
  useInspectorCommandStore.setState({ pendingFileChatDraft: null });
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

/**
 * Two pages as pdf.js lays out their text layers: positioned spans, a `<br>`
 * ending each line, and an end-of-content marker the viewer moves while the
 * reader drags.
 */
const mountViewer = (
  chat: (typeof PDF_SELECTION_CHAT)[keyof typeof PDF_SELECTION_CHAT],
) => {
  const rootRef = createRef<HTMLDivElement>();
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
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
          <div ref={rootRef}>
            <div data-page-id="page-a">
              <div data-text-layer="page-a">
                <span>{LINE_ONE}</span>
                <br />
                <span>{LINE_TWO}</span>
                <div className={EOC_CLASS_NAME} />
              </div>
              <p>{OVERLAY_LABEL}</p>
            </div>
            <div data-page-id="page-b">
              <div data-text-layer="page-b">
                <span>{PAGE_TWO_TEXT}</span>
              </div>
            </div>
          </div>
          <PdfSelectionToolbar
            chat={chat}
            citedDocument={{
              fileFieldId: FILE_FIELD_ID,
              name: "Purchase agreement.pdf",
              reference: "2026/014",
            }}
            pageNumberOf={(pageId) => {
              const index = PAGE_IDS.indexOf(pageId);
              return index === -1 ? null : index + 1;
            }}
            rootRef={rootRef}
          />
        </ActionCapabilitiesProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return view;
};

const textNode = (view: ReturnType<typeof mountViewer>, text: string) => {
  const node = view.getByText(text).firstChild;
  if (!(node instanceof Text)) {
    throw new TypeError(`Missing text fixture: ${text}`);
  }
  return node;
};

const select = async (start: Text, end: Text) => {
  const range = document.createRange();
  range.setStart(start, 0);
  range.setEnd(end, end.length);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
  await act(async () => {
    document.dispatchEvent(new Event("selectionchange"));
    await new Promise((resolve) => {
      requestAnimationFrame(resolve);
    });
  });
};

test("selecting words in the text layer shows the selection bar", async () => {
  const view = mountViewer(PDF_SELECTION_CHAT.fileChat);
  expect(view.queryByRole("button", { name: "Copy" })).toBeNull();

  await select(textNode(view, LINE_ONE), textNode(view, LINE_TWO));

  expect(await view.findByRole("button", { name: "Copy" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Ask AI" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Explain" })).toBeTruthy();
});

test("a selection outside every text layer gets no bar", async () => {
  const view = mountViewer(PDF_SELECTION_CHAT.fileChat);
  const label = textNode(view, OVERLAY_LABEL);

  await select(label, label);

  expect(view.queryByRole("button", { name: "Copy" })).toBeNull();
});

test("each copy format writes the passage with the document's citation", async () => {
  const view = mountViewer(PDF_SELECTION_CHAT.fileChat);
  const expected = {
    "Quote with citation":
      "“The seller shall deliver the goods.” Purchase agreement.pdf, 2026/014, p. 1.",
    "Citation with quote":
      "Purchase agreement.pdf, 2026/014, p. 1 (“The seller shall deliver the goods.”).",
    "Block quote with citation":
      "The seller shall deliver the goods.\n\nPurchase agreement.pdf, 2026/014, p. 1.",
    "Text only": "The seller shall deliver the goods.",
    "Citation only": "Purchase agreement.pdf, 2026/014, p. 1.",
  };

  for (const [option, text] of Object.entries(expected)) {
    await select(textNode(view, LINE_ONE), textNode(view, LINE_TWO));
    fireEvent.click(await view.findByRole("button", { name: "Copy" }));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: option }));
    });
    expect(clipboardWrites.at(-1)).toBe(text);
  }
  expect(clipboardWrites).toHaveLength(Object.keys(expected).length);
});

test("a passage across pages cites the page range", async () => {
  const view = mountViewer(PDF_SELECTION_CHAT.fileChat);

  await select(textNode(view, LINE_TWO), textNode(view, PAGE_TWO_TEXT));
  fireEvent.click(await view.findByRole("button", { name: "Copy" }));
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Citation only" }));
  });

  expect(clipboardWrites).toEqual([
    "Purchase agreement.pdf, 2026/014, pp. 1–2.",
  ]);
});

test("Ask AI drafts the passage in the document's chat for the reader to finish", async () => {
  const view = mountViewer(PDF_SELECTION_CHAT.fileChat);
  await select(textNode(view, LINE_ONE), textNode(view, LINE_TWO));

  fireEvent.click(await view.findByRole("button", { name: "Ask AI" }));

  expect(useInspectorCommandStore.getState().pendingFileChatDraft).toEqual({
    fileFieldId: FILE_FIELD_ID,
    handoff: {
      type: "passage",
      quote: {
        label: "p. 1",
        source: "paste",
        text: "About this passage of Purchase agreement.pdf, 2026/014, p. 1:\n\n“The seller shall deliver the goods.”",
      },
    },
    sequence: 1,
  });
  expect(document.getSelection()?.isCollapsed ?? true).toBe(true);
});

test("Explain sends the passage to the document's chat at once", async () => {
  const view = mountViewer(PDF_SELECTION_CHAT.fileChat);
  await select(textNode(view, LINE_ONE), textNode(view, LINE_TWO));

  fireEvent.click(await view.findByRole("button", { name: "Explain" }));

  expect(useInspectorCommandStore.getState().pendingFileChatDraft).toEqual({
    fileFieldId: FILE_FIELD_ID,
    handoff: {
      type: "prose",
      delivery: "send",
      markdown: composerText(
        "Explain this passage of Purchase agreement.pdf, 2026/014, p. 1:\n\n“The seller shall deliver the goods.”",
      ),
    },
    sequence: 1,
  });
});

test("a viewer without the document's chat offers copy but no AI action", async () => {
  const view = mountViewer(PDF_SELECTION_CHAT.none);
  await select(textNode(view, LINE_ONE), textNode(view, LINE_TWO));

  expect(await view.findByRole("button", { name: "Copy" })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Ask AI" })).toBeNull();
  expect(view.queryByRole("button", { name: "Explain" })).toBeNull();
});
