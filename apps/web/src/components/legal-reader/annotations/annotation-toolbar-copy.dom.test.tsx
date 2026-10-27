import { createRef } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Result } from "better-result";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

import { createWebTestEnvironment } from "../../../../tests/environment.test-fixtures";

GlobalRegistrator.register({ url: "https://app.example.test/law" });
const testEnvironment = createWebTestEnvironment({ file: import.meta.path });
testEnvironment.setEnvIfAbsent("VITE_API_URL", "https://api.example.test");
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { stellaToast } = await import("@stll/ui/toast");
const { AnnotationToolbar } = await import("./annotation-toolbar");

const SELECTED_TEXT = "Selected reader text";
const OUTSIDE_TEXT = "Outside text";

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

const mountToolbar = async () => {
  const rootRef = createRef<HTMLElement>();
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <article ref={rootRef} style={{ overflow: "visible" }}>
          <p data-anchor="paragraph-1">{SELECTED_TEXT}</p>
        </article>
        <p>{OUTSIDE_TEXT}</p>
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
          onClearActive={() => undefined}
          scrollContainerRef={rootRef}
          target={{
            type: "decision",
            id: "decision-1",
            caseNumber: "1 Test 1",
            caseNumberType: "case-number",
            country: "CZ",
            court: "Test court",
            decisionDate: null,
            decisionType: null,
            ecli: null,
            name: null,
          }}
        />
      </IntlProvider>
    </QueryClientProvider>,
  );
  const readerText = view.getByText(SELECTED_TEXT).firstChild;
  const root = rootRef.current;
  if (readerText === null || root === null) {
    throw new TypeError("Reader fixture is missing");
  }
  const range = document.createRange();
  range.setStart(readerText, 0);
  range.setEnd(readerText, readerText.textContent?.length ?? 0);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
  await act(async () => document.dispatchEvent(new Event("selectionchange")));
  await view.findByRole("button", { name: "Copy" });
  return view;
};

test("native copy confirms only for a selection inside the reader", async () => {
  const view = await mountToolbar();

  await act(async () => {
    document.dispatchEvent(new Event("copy", { bubbles: true }));
  });
  expect(view.getByRole("button", { name: "Copied" })).toBeTruthy();

  await act(async () => cleanup());
  const outsideView = await mountToolbar();

  const outside = outsideView.getByText(OUTSIDE_TEXT).firstChild;
  if (outside === null) {
    throw new TypeError("Outside selection fixture is missing");
  }
  const range = document.createRange();
  range.selectNodeContents(outside);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
  await act(async () => {
    document.dispatchEvent(new Event("copy", { bubbles: true }));
  });

  expect(outsideView.queryByRole("button", { name: "Copied" })).toBeNull();
});

test("a copy format confirms in place without a success toast", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => undefined },
  });
  const toast = spyOn(stellaToast, "add");
  const view = await mountToolbar();

  fireEvent.click(view.getByRole("button", { name: "Copy" }));
  fireEvent.click(view.getByRole("button", { name: "Text only" }));

  await view.findByRole("button", { name: "Copied" });
  expect(toast).not.toHaveBeenCalled();
  toast.mockRestore();
});

test("a failed copy reports the error without confirming", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => await Promise.reject(new Error("denied")) },
  });
  const toast = spyOn(stellaToast, "add").mockReturnValue("error-toast");
  const view = await mountToolbar();

  fireEvent.click(view.getByRole("button", { name: "Copy" }));
  fireEvent.click(view.getByRole("button", { name: "Text only" }));

  await waitFor(() => expect(toast).toHaveBeenCalled());
  expect(view.queryByRole("button", { name: "Copied" })).toBeNull();
  toast.mockRestore();
});

test("picking a copy format returns focus to the copy trigger", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => undefined },
  });
  const view = await mountToolbar();

  fireEvent.click(view.getByRole("button", { name: "Copy" }));
  const option = view.getByRole("button", { name: "Text only" });
  option.focus();
  fireEvent.click(option);

  const trigger = await view.findByRole("button", { name: "Copied" });
  expect(document.activeElement).toBe(trigger);
});

test("a copy that settles after the selection changed does not confirm", async () => {
  const pending = Promise.withResolvers<undefined>();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => await pending.promise },
  });
  const view = await mountToolbar();

  fireEvent.click(view.getByRole("button", { name: "Copy" }));
  fireEvent.click(view.getByRole("button", { name: "Text only" }));
  await act(async () => document.dispatchEvent(new Event("selectionchange")));
  await act(async () => {
    pending.resolve(undefined);
    await pending.promise;
  });

  expect(view.queryByRole("button", { name: "Copied" })).toBeNull();
  expect(view.getByRole("button", { name: "Copy" })).toBeTruthy();
});

test("a new selection clears the previous copy's confirmation", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => undefined },
  });
  const view = await mountToolbar();

  fireEvent.click(view.getByRole("button", { name: "Copy" }));
  fireEvent.click(view.getByRole("button", { name: "Text only" }));
  await view.findByRole("button", { name: "Copied" });
  await act(async () => document.dispatchEvent(new Event("selectionchange")));

  expect(view.queryByRole("button", { name: "Copied" })).toBeNull();
});
