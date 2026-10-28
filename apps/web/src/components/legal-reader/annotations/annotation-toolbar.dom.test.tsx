import { createRef } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Result } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test/reader" });
const { act, cleanup, fireEvent, render } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { AnnotationToolbar } = await import("./annotation-toolbar");
const { cleanSelectionText } = await import("./reader-copy-text.logic");

const SELECTED_TEXT = "Selected passage";

const originalRects = Object.getOwnPropertyDescriptor(
  Range.prototype,
  "getClientRects",
);

afterEach(async () => {
  if (originalRects !== undefined) {
    Object.defineProperty(Range.prototype, "getClientRects", originalRects);
  }
  document.getSelection()?.removeAllRanges();
  await act(async () => cleanup());
});
afterAll(async () => await unregisterDomEnvironment());

test("copy text preserves block boundaries while normalizing inline whitespace", () => {
  const root = document.createElement("div");
  root.innerHTML =
    "<p>First   paragraph<span data-reader-chrome>Page 2</span></p><p>Second\tparagraph</p>";
  const range = document.createRange();
  range.selectNodeContents(root);

  expect(cleanSelectionText(range)).toBe("First paragraph\nSecond paragraph");
});

test.each([100, 650])(
  "copy menu uses viewport coordinates outside the toolbar at y=%s",
  async (top) => {
    const rootRef = createRef<HTMLDivElement>();
    const onClearActiveCalls: string[] = [];
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <div ref={rootRef}>
            <p>{SELECTED_TEXT}</p>
          </div>
          <AnnotationToolbar
            activeAnnotation={null}
            activeSpans={[]}
            controller={{
              create: async () => Result.ok(undefined),
              redo: async () => undefined,
              remove: async () => Result.ok(undefined),
              undo: async () => undefined,
              update: async () => Result.ok(undefined),
            }}
            mode="guest"
            onActivateAnnotation={() => undefined}
            onClearActive={() => {
              onClearActiveCalls.push("clear");
            }}
            scrollContainerRef={rootRef}
            target={{
              type: "statute",
              id: "statute",
              country: "CZ",
              eli: "https://example.test/statute",
              provisionByAnchorId: new Map(),
              title: "Statute",
              versionValidFrom: null,
            }}
          />
        </IntlProvider>
      </QueryClientProvider>,
    );
    const root = rootRef.current;
    const leaf = view.getByText(SELECTED_TEXT);
    const text = leaf.firstChild;
    if (root === null || text === null) {
      throw new TypeError("Selection fixture is missing");
    }
    root.getBoundingClientRect = () => new DOMRect(0, 0, 900, 768);
    for (
      let node: HTMLElement | null = root;
      node !== null;
      node = node.parentElement
    ) {
      node.style.overflowX = "visible";
      node.style.overflowY = "visible";
    }
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 16);
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => {
        const rect = new DOMRect(200, top, 140, 20);
        return {
          0: rect,
          length: 1,
          item: () => rect,
          [Symbol.iterator]: () => [rect][Symbol.iterator](),
        };
      },
    });
    document.getSelection()?.addRange(range);
    await act(async () => {
      fireEvent.pointerUp(leaf, { clientX: 250, clientY: top + 10 });
      await new Promise((resolve) => {
        requestAnimationFrame(resolve);
      });
    });
    const trigger = view.getByRole("button", { name: "Copy" });
    const bar = trigger.closest(".reader-chrome");
    if (!(bar instanceof HTMLElement)) {
      throw new TypeError("Missing selection toolbar");
    }
    bar.getBoundingClientRect = () => new DOMRect(200, top, 300, 36);
    fireEvent.click(trigger);
    const option = view.getByRole("button", {
      name: messages.legalReader.copyMenu.textOnly,
    });
    const menu = option.closest(".fixed");
    expect(menu?.parentElement === document.body).toBe(true);
    expect(bar.contains(menu)).toBe(false);
    expect(menu).toHaveProperty("style.left", "200px");
    if (top === 100) {
      expect(menu).toHaveProperty("style.top", "140px");
    } else {
      expect(menu).toHaveProperty(
        "style.bottom",
        `${window.innerHeight - top + 4}px`,
      );
    }
    onClearActiveCalls.length = 0;
    fireEvent.pointerDown(option);
    await act(async () => {
      fireEvent.pointerUp(option);
      await new Promise((resolve) => {
        requestAnimationFrame(resolve);
      });
    });
    expect(onClearActiveCalls).toEqual([]);
    expect(
      view.getByRole("button", {
        name: messages.legalReader.copyMenu.textOnly,
      }) === option,
    ).toBe(true);
    expect(document.getSelection()?.toString()).toBe(SELECTED_TEXT);
  },
);
