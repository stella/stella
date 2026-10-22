/* oxlint-disable no-untranslated-jsx-literal/no-untranslated-jsx-literal -- Reader text fixture, never user-facing copy. */
import { useRef } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Result } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

import type { GuestAnnotationStore } from "@/components/legal-reader/annotations/guest-annotation-store.logic";
import type { ReaderAnnotationWrites } from "@/components/legal-reader/annotations/reader-annotation-history.logic";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test/reader" });
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { detectPlatform } = await import("@tanstack/react-hotkeys");
const { IntlProvider } = await import("use-intl");
const { ToastProvider } = await import("@stll/ui/toast");
const { default: messages } = await import("@/i18n/langs/en.json");
const { AnnotationToolbar } = await import("./annotation-toolbar");
const {
  createGuestAnnotation,
  deleteGuestAnnotation,
  EMPTY_GUEST_ANNOTATION_STORE,
  guestAnnotationRows,
  updateGuestAnnotation,
} = await import("./guest-annotation-store.logic");
const { useReaderAnnotationHistory } =
  await import("./use-reader-annotation-history");

const PASSAGE = "Selected passage";
const target = {
  targetId: "019b0121-9dd7-7000-8000-0000000000aa",
  targetType: "decision",
} as const;

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

/** The tab store as the engine, with every write the reader makes logged. */
const recordingStore = () => {
  let store: GuestAnnotationStore = EMPTY_GUEST_ANNOTATION_STORE;
  let next = 0;
  const calls: string[] = [];
  const writes: ReaderAnnotationWrites = {
    create: async (input) => {
      store = createGuestAnnotation({
        input,
        newId: () => {
          next += 1;
          return `019b0121-9dd7-7000-8000-${String(next).padStart(12, "0")}`;
        },
        now: new Date("2026-10-22T10:00:00.000Z"),
        store,
        target,
      });
      const ids = store.items.at(-1)?.rowIds ?? [];
      calls.push(`create:${input.kind}:${ids.join(",")}`);
      return Result.ok(ids);
    },
    remove: async (id) => {
      calls.push(`remove:${id}`);
      store = deleteGuestAnnotation(store, id);
      return Result.ok(undefined);
    },
    rows: () => guestAnnotationRows({ authorName: "You", store, target }),
    update: async (input) => {
      calls.push(`update:${input.change}:${input.id}`);
      store = updateGuestAnnotation(store, input);
      return Result.ok(undefined);
    },
  };
  return { calls, writes };
};

const Reader = ({ writes }: { writes: ReaderAnnotationWrites }) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const controller = useReaderAnnotationHistory({
    scope: `${target.targetType}:${target.targetId}`,
    writes,
  });
  return (
    <>
      <div ref={rootRef}>
        <p data-anchor="p-1">{PASSAGE}</p>
        <textarea aria-label="Draft note" dir="ltr" />
      </div>
      <AnnotationToolbar
        activeAnnotation={null}
        activeSpans={[]}
        controller={controller}
        mode="guest"
        onActivateAnnotation={() => undefined}
        onClearActive={() => undefined}
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
    </>
  );
};

const renderReader = () => {
  const store = recordingStore();
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ToastProvider>
          <Reader writes={store.writes} />
        </ToastProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return { ...store, view };
};

/** Selects the passage the way a pointer does, so the bar opens over it. */
const selectPassage = async (view: ReturnType<typeof render>) => {
  const leaf = view.getByText(PASSAGE);
  const text = leaf.firstChild;
  if (text === null) {
    throw new TypeError("Passage fixture is missing");
  }
  for (
    let node: HTMLElement | null = leaf;
    node !== null;
    node = node.parentElement
  ) {
    node.style.overflowX = "visible";
    node.style.overflowY = "visible";
  }
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => {
      const rect = new DOMRect(200, 100, 140, 20);
      return {
        0: rect,
        length: 1,
        item: () => rect,
        [Symbol.iterator]: () => [rect][Symbol.iterator](),
      };
    },
  });
  fireEvent.pointerDown(leaf, { button: 0 });
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, PASSAGE.length);
  document.getSelection()?.addRange(range);
  await act(async () => {
    fireEvent.pointerUp(leaf, { clientX: 250, clientY: 110 });
    await new Promise((resolve) => {
      requestAnimationFrame(resolve);
    });
  });
};

const undoChord = (element: Element) => {
  const mac = detectPlatform() === "mac";
  fireEvent.keyDown(element, {
    code: "KeyZ",
    ctrlKey: !mac,
    key: "z",
    metaKey: mac,
  });
};

test("Mod+Z after highlighting a passage removes that highlight", async () => {
  const { calls, view } = renderReader();
  await selectPassage(view);
  fireEvent.click(
    view.getByRole("button", {
      name: messages.legalReader.annotations.colorYellow,
    }),
  );
  await waitFor(() => {
    expect(calls).toHaveLength(1);
  });
  const created = calls.at(0) ?? "";
  expect(created).toStartWith("create:highlight:");
  const rowId = created.split(":").at(-1);

  await act(async () => {
    undoChord(document.body);
  });
  await waitFor(() => {
    expect(calls).toEqual([created, `remove:${rowId}`]);
  });
  await waitFor(() => {
    expect(
      view.getByText(messages.legalReader.annotations.history.highlightRemoved),
    ).toBeTruthy();
  });
});

test("Mod+Z inside a text field leaves the marks alone", async () => {
  const { calls, view } = renderReader();
  await selectPassage(view);
  fireEvent.click(
    view.getByRole("button", {
      name: messages.legalReader.annotations.colorGreen,
    }),
  );
  await waitFor(() => {
    expect(calls).toHaveLength(1);
  });

  const field = view.getByRole("textbox", { name: "Draft note" });
  field.focus();
  await act(async () => {
    undoChord(field);
    await sleep(20);
  });
  expect(calls).toHaveLength(1);

  // The step is still there for the reader once the field is left.
  field.blur();
  fireEvent.pointerDown(view.getByText(PASSAGE), { button: 0 });
  await act(async () => {
    undoChord(document.body);
  });
  await waitFor(() => {
    expect(calls.at(1)).toStartWith("remove:");
  });
});

test("Mod+Z with nothing done says there is nothing to undo", async () => {
  const { calls, view } = renderReader();
  fireEvent.pointerDown(view.getByText(PASSAGE), { button: 0 });
  await act(async () => {
    undoChord(document.body);
  });
  await waitFor(() => {
    expect(
      view.getByText(messages.legalReader.annotations.history.nothingToUndo),
    ).toBeTruthy();
  });
  expect(calls).toEqual([]);
});

test("Mod+Z after pressing outside the reader does not reach its marks", async () => {
  const { calls, view } = renderReader();
  await selectPassage(view);
  fireEvent.click(
    view.getByRole("button", {
      name: messages.legalReader.annotations.colorRed,
    }),
  );
  await waitFor(() => {
    expect(calls).toHaveLength(1);
  });
  fireEvent.pointerDown(document.body, { button: 0 });
  await act(async () => {
    undoChord(document.body);
    await sleep(20);
  });
  expect(calls).toHaveLength(1);
});
