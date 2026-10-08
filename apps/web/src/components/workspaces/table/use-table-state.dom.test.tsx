import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ColumnSizingState } from "@tanstack/react-table";
import { afterAll, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

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
  await GlobalRegistrator.unregister();
});

test("pending table widths publish only for the owner that resized them", async () => {
  const queryClient = new QueryClient();
  const areas = () => ({ local: null, session: null });
  const unsubscribe = installUserScopedStorage(queryClient, areas);
  const published: ColumnSizingState[] = [];
  const layouts: unknown[] = [];
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
      await sleep(150);
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
      await sleep(150);
    });
    expect(published).toEqual([{ column: 350 }]);
    mounted.unmount();
  } finally {
    cleanup();
    unsubscribe();
    releaseUserStorage(areas());
    queryClient.clear();
  }
});
