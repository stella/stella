import { useLayoutEffect, useRef } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Result } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

import type { CreateAnnotationInput } from "@/components/legal-reader/annotations/annotation-types";
import type { GuestAnnotationStore } from "@/components/legal-reader/annotations/guest-annotation-store.logic";
import type { ReaderAnnotationWrites } from "@/components/legal-reader/annotations/reader-annotation-history.logic";
import { unregisterDomEnvironment } from "@/test-dom-environment";

import type { ReaderAnnotationController } from "./use-reader-annotation-history";

GlobalRegistrator.register({ url: "https://app.example.test/reader" });
const { act, cleanup, fireEvent, render, renderHook, waitFor } =
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
  if (rowId === undefined) {
    throw new TypeError("Recorded create call is missing its row ID");
  }

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

const scopeInput = {
  kind: "highlight",
  color: "yellow",
  style: "highlight",
  visibility: "private",
  spans: [
    {
      blockAnchorId: "p-1",
      startOffset: 0,
      endOffset: PASSAGE.length,
      quote: PASSAGE,
      quotePrefix: "",
      quoteSuffix: "",
    },
  ],
} satisfies CreateAnnotationInput;

type ScopeHistoryProps = {
  scope: string;
  writes: ReaderAnnotationWrites;
  onCommit?: (controller: ReaderAnnotationController) => void;
  onDispose?: (controller: ReaderAnnotationController) => void;
};

const scopeHistory = (initialProps: ScopeHistoryProps) =>
  renderHook(
    ({ scope, writes, onCommit, onDispose }: ScopeHistoryProps) => {
      const controller = useReaderAnnotationHistory({ scope, writes });
      useLayoutEffect(() => {
        onCommit?.(controller);
      });
      useLayoutEffect(
        () => () => onDispose?.(controller),
        [controller, onDispose],
      );
      return controller;
    },
    {
      initialProps,
      wrapper: ({ children }) => (
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <ToastProvider>{children}</ToastProvider>
        </IntlProvider>
      ),
    },
  );

test("queued undo stays with its requesting scope while another document completes a write", async () => {
  const a = recordingStore();
  const b = recordingStore();
  const pending = Promise.withResolvers<undefined>();
  const delayed = {
    ...a.writes,
    create: async (input: CreateAnnotationInput) => {
      await pending.promise;
      return await a.writes.create(input);
    },
  };
  const view = scopeHistory({ scope: "A", writes: delayed });
  const creating = view.result.current.create(scopeInput);
  const undoing = view.result.current.undo();
  await act(async () => {
    await Promise.resolve();
  });
  view.rerender({ scope: "B", writes: b.writes });
  await act(async () => {
    await view.result.current.create(scopeInput);
  });
  await act(async () => {
    pending.resolve(undefined);
    await Promise.all([creating, undoing]);
  });
  expect(a.calls).toHaveLength(1);
  expect(b.calls).toHaveLength(1);
  expect(b.calls.at(0)).toStartWith("create:");
  await act(async () => {
    await view.result.current.undo();
  });
  expect(b.calls.at(1)).toStartWith("remove:");
});

test("returning to a previous document or account starts a fresh history", async () => {
  const a = recordingStore();
  const b = recordingStore();
  const view = scopeHistory({ scope: "A", writes: a.writes });
  await act(async () => {
    await view.result.current.create(scopeInput);
  });
  view.rerender({ scope: "B", writes: b.writes });
  view.rerender({ scope: "A", writes: a.writes });
  await act(async () => {
    await view.result.current.undo();
  });
  expect(a.calls).toHaveLength(1);
  expect(b.calls).toEqual([]);
});

test("a previous scope's deferred write cannot repopulate history after returning", async () => {
  const a = recordingStore();
  const pending = Promise.withResolvers<undefined>();
  const delayed = {
    ...a.writes,
    create: async (input: CreateAnnotationInput) => {
      await pending.promise;
      return await a.writes.create(input);
    },
  };
  const view = scopeHistory({ scope: "A", writes: delayed });
  const creating = view.result.current.create(scopeInput);
  view.rerender({ scope: "B", writes: recordingStore().writes });
  view.rerender({ scope: "A", writes: a.writes });
  await act(async () => {
    pending.resolve(undefined);
    await creating;
  });
  await act(async () => {
    await view.result.current.undo();
  });
  expect(a.calls).toHaveLength(1);
});

test("unmounting discards an undo waiting on an earlier write", async () => {
  const store = recordingStore();
  const pending = Promise.withResolvers<undefined>();
  const view = scopeHistory({
    scope: "A",
    writes: {
      ...store.writes,
      create: async (input) => {
        await pending.promise;
        return await store.writes.create(input);
      },
    },
  });
  const creating = view.result.current.create(scopeInput);
  const undoing = view.result.current.undo();
  await act(async () => {
    await Promise.resolve();
  });
  view.unmount();
  await act(async () => {
    pending.resolve(undefined);
    await Promise.all([creating, undoing]);
  });
  expect(store.calls).toHaveLength(1);
});

test("scope commit retires old work and accepts new writes before passive effects", async () => {
  const a = recordingStore();
  const b = recordingStore();
  const pending = Promise.withResolvers<undefined>();
  const view = scopeHistory({
    scope: "A",
    writes: {
      ...a.writes,
      create: async (input) => {
        await pending.promise;
        return await a.writes.create(input);
      },
    },
  });
  const previous = view.result.current;
  const creating = previous.create(scopeInput);
  const undoing = previous.undo();
  const next = Promise.withResolvers<Promise<unknown>[]>();
  view.rerender({
    scope: "B",
    writes: b.writes,
    onCommit: (controller) => {
      pending.resolve(undefined);
      next.resolve([
        previous.create(scopeInput),
        controller.create(scopeInput),
      ]);
    },
  });
  await act(async () => {
    await Promise.all([creating, undoing, ...(await next.promise)]);
  });
  expect(a.calls).toHaveLength(1);
  expect(b.calls).toHaveLength(1);
});

test("unmount commit rejects stale writes before passive cleanup", async () => {
  const store = recordingStore();
  const view = scopeHistory({ scope: "A", writes: store.writes });
  const completed = Promise.withResolvers<Promise<unknown>>();
  view.rerender({
    scope: "A",
    writes: store.writes,
    onDispose: (controller) => completed.resolve(controller.create(scopeInput)),
  });
  view.unmount();
  await act(async () => {
    await completed.promise;
  });
  expect(store.calls).toEqual([]);
});
