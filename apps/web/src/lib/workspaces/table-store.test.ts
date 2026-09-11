import { beforeEach, describe, expect, test } from "bun:test";

import {
  readPersistedTableState,
  TABLE_STORE_VERSION,
} from "@/lib/workspaces/table-store.logic";

const V1_PAYLOAD = {
  state: {
    columnSizing: { "ws-1": { "view-1": { col_a: 200, col_b: 150 } } },
    contentMode: { "ws-1": { "view-1": "fit-content" as const } },
  },
  version: TABLE_STORE_VERSION,
};

describe("the persisted table state's read boundary", () => {
  test("reads a current payload back as written", () => {
    expect(readPersistedTableState(JSON.stringify(V1_PAYLOAD))).toEqual(
      V1_PAYLOAD,
    );
  });

  test("reads a missing key, broken JSON, a wrong shape and an old version as absent", () => {
    const v0 = {
      state: {
        columnSizing: { __map: [["view-1", { col_a: 200 }]] },
        contentMode: { "view-1": "tight" },
      },
      version: 0,
    };
    expect(readPersistedTableState(null)).toBeNull();
    expect(readPersistedTableState("{truncated")).toBeNull();
    expect(readPersistedTableState("{}")).toBeNull();
    expect(readPersistedTableState(JSON.stringify(v0))).toBeNull();
    expect(
      readPersistedTableState(
        JSON.stringify({ ...V1_PAYLOAD, version: TABLE_STORE_VERSION + 1 }),
      ),
    ).toBeNull();
  });
});

// The store's `persist` middleware writes on every change, so it needs a
// Storage before the module is evaluated.
const stored = new Map<string, string>();
globalThis.localStorage = {
  clear: () => {
    stored.clear();
  },
  getItem: (key: string) => stored.get(key) ?? null,
  key: (index: number) => [...stored.keys()][index] ?? null,
  get length() {
    return stored.size;
  },
  removeItem: (key: string) => {
    stored.delete(key);
  },
  setItem: (key: string, value: string) => {
    stored.set(key, value);
  },
};

const { useTableStore } = await import("@/lib/workspaces/table-store");

const v1 = { workspaceId: "ws-1", viewId: "v1" };
const v2 = { workspaceId: "ws-1", viewId: "v2" };
const otherMatter = { workspaceId: "ws-2", viewId: "v1" };
const findOf = ({ workspaceId, viewId }: typeof v1) =>
  useTableStore.getState().find[workspaceId]?.[viewId];

test("the persisted key is written at the current version", () => {
  useTableStore.getState().setColumnSizing(v1, { col_a: 120 });

  expect(readPersistedTableState(stored.get("stella:table") ?? null)).toEqual({
    state: {
      columnSizing: { "ws-1": { v1: { col_a: 120 } } },
      contentMode: {},
    },
    version: TABLE_STORE_VERSION,
  });
});

describe("a view's find bar", () => {
  beforeEach(() => {
    useTableStore.setState({ find: {} });
  });

  test("opens unrestricted and empty", () => {
    useTableStore.getState().openFind(v1);

    expect(findOf(v1)).toEqual({
      scope: { type: "all" },
      status: "open",
      submitted: "",
      typed: "",
    });
  });

  test("keeps what was typed when the shortcut fires again", () => {
    const { openFind, setFindTyped, submitFind } = useTableStore.getState();
    openFind(v1);
    setFindTyped(v1, "lease");
    submitFind(v1);

    openFind(v1);

    expect(findOf(v1)?.submitted).toBe("lease");
  });

  test("holds what is typed back until it is submitted", () => {
    const { openFind, setFindTyped, submitFind } = useTableStore.getState();
    openFind(v1);
    setFindTyped(v1, "lea");

    expect(findOf(v1)).toMatchObject({ submitted: "", typed: "lea" });

    submitFind(v1);

    expect(findOf(v1)?.submitted).toBe("lea");
  });

  test("closing hides the bar and keeps the find, so the rows stay narrowed", () => {
    const { openFind, setFindTyped, submitFind, closeFind, setFindScope } =
      useTableStore.getState();
    openFind(v1);
    setFindTyped(v1, "lease");
    submitFind(v1);
    setFindScope(v1, { propertyIds: ["p1"], type: "columns" });

    closeFind(v1);
    expect(findOf(v1)).toEqual({
      scope: { propertyIds: ["p1"], type: "columns" },
      status: "closed",
      submitted: "lease",
      typed: "lease",
    });

    openFind(v1);
    expect(findOf(v1)?.status).toBe("open");
  });

  test("clearing is the only thing that ends a find", () => {
    const { openFind, setFindTyped, submitFind, closeFind, clearFind } =
      useTableStore.getState();
    openFind(v1);
    setFindTyped(v1, "lease");
    submitFind(v1);
    closeFind(v1);

    clearFind(v1);

    expect(useTableStore.getState().find).toEqual({});
  });

  test("edits nothing for a view with no find", () => {
    const { setFindTyped, submitFind, setFindScope } = useTableStore.getState();
    setFindTyped(v1, "lease");
    submitFind(v1);
    setFindScope(v1, { propertyIds: ["p1"], type: "columns" });

    expect(useTableStore.getState().find).toEqual({});
  });

  test("the same view id in another matter is another find", () => {
    const { openFind, setFindTyped } = useTableStore.getState();
    openFind(v1);
    openFind(otherMatter);
    setFindTyped(otherMatter, "invoice");

    expect(findOf(v1)?.typed).toBe("");
    expect(findOf(otherMatter)?.typed).toBe("invoice");
  });
});

describe("reconciling the store against a matter's views", () => {
  beforeEach(() => {
    useTableStore.setState({
      columnSizing: {},
      contentMode: {},
      rowSelection: {},
      selectedEntities: {},
      preservableRowIds: {},
      find: {},
    });
  });

  test("drops every record of a view the matter no longer lists", () => {
    const store = useTableStore.getState();
    for (const ref of [v1, v2]) {
      store.setColumnSizing(ref, { col_a: 100 });
      store.setContentMode(ref, "fit-content");
      store.setRowSelection(ref, { row: true });
      store.setPreservableRowIds(ref, ["row"]);
      store.openFind(ref);
    }
    // Seeded directly: the setter skips an empty selection for a view with none.
    useTableStore.setState({
      selectedEntities: { "ws-1": { v1: [], v2: [] } },
    });

    store.reconcileViews("ws-1", ["v2"]);

    const state = useTableStore.getState();
    for (const record of [
      state.columnSizing,
      state.contentMode,
      state.rowSelection,
      state.selectedEntities,
      state.preservableRowIds,
      state.find,
    ]) {
      expect(Object.keys(record["ws-1"] ?? {})).toEqual(["v2"]);
    }
  });

  test("leaves another matter's records alone and drops an emptied matter", () => {
    const store = useTableStore.getState();
    store.setColumnSizing(v1, { col_a: 100 });
    store.setColumnSizing(otherMatter, { col_a: 300 });

    store.reconcileViews("ws-1", []);

    expect(useTableStore.getState().columnSizing).toEqual({
      "ws-2": { v1: { col_a: 300 } },
    });
  });
});
