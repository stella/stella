import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ColumnSizingState } from "@tanstack/react-table";
import { afterAll, expect, jest, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";
import { restoreRealTimers } from "@stll/property-testing/fake-timers";

GlobalRegistrator.register({ url: "http://localhost:3000/table" });
const { act, cleanup, renderHook } = await import("@testing-library/react");
const { QueryClient } = await import("@tanstack/react-query");
const { installUserScopedStorage } =
  await import("@/lib/account/install-user-scoped-storage");
const { releaseUserStorage } =
  await import("@/lib/account/user-scoped-storage");
const { useTableState } = await import("./use-table-state");

afterAll(async () => {
  cleanup();
  await unregisterDomEnvironment();
});

test("pending table widths publish only for the owner that resized them", async () => {
  const queryClient = new QueryClient();
  const areas = () => ({ local: null, session: null });
  const unsubscribe = installUserScopedStorage(queryClient, areas);
  const published: ColumnSizingState[] = [];
  const layouts: unknown[] = [];
  jest.useFakeTimers();
  try {
    queryClient.setQueryData(["session"], { user: { id: "user-a" } });
    const mounted = renderHook(
      ({ sizing }: { sizing: ColumnSizingState }) =>
        useTableState({
          columnLayout: {
            hidden: [],
            order: [],
            pinned: [],
            onChange: (layout) => {
              layouts.push(layout);
            },
          },
          columnSizing: {
            sizing,
            onChange: (next) => {
              published.push(next);
            },
          },
          rowSelection: { selection: {}, onChange: () => undefined },
          sorting: null,
        }),
      { initialProps: { sizing: { column: 100 } } },
    );
    const retainedListeners = mounted.result.current.listeners;
    act(() => {
      mounted.result.current.listeners.onColumnSizingChange({ column: 150 });
      queryClient.setQueryData(["session"], { user: { id: "user-b" } });
    });
    await act(async () => {
      jest.advanceTimersByTime(150);
      await Promise.resolve();
    });
    expect(published).toEqual([]);
    act(() => {
      retainedListeners.onColumnOrderChange(["old-column"]);
      retainedListeners.onColumnPinningChange({
        start: ["old-column"],
        end: [],
      });
      retainedListeners.onColumnVisibilityChange({ "old-column": false });
    });
    expect(layouts).toEqual([]);
    mounted.rerender({ sizing: { column: 300 } });
    expect(mounted.result.current.state.columnSizing).toEqual({ column: 300 });
    act(() =>
      mounted.result.current.listeners.onColumnSizingChange({ column: 350 }),
    );
    await act(async () => {
      jest.advanceTimersByTime(150);
      await Promise.resolve();
    });
    expect(published).toEqual([{ column: 350 }]);
    mounted.unmount();
  } finally {
    restoreRealTimers();
    cleanup();
    unsubscribe();
    releaseUserStorage(areas());
    queryClient.clear();
  }
});
