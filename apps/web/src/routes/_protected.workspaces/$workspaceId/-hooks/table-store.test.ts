import { beforeEach, describe, expect, test } from "bun:test";
import { enableMapSet } from "immer";
import * as v from "valibot";

const MAP_TAG = "__map";

const replacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Map) {
    return { [MAP_TAG]: [...value.entries()] };
  }
  return value;
};

type ColumnSizingState = Record<string, number>;
type TableContentMode = "tight" | "fit-content";

type StorageShape = {
  state: {
    columnSizing: Map<string, ColumnSizingState>;
    contentMode: Record<string, TableContentMode>;
  };
  version: number;
};

const StorageSchema = v.strictObject({
  state: v.strictObject({
    columnSizing: v.strictObject({
      [MAP_TAG]: v.array(
        v.tuple([v.string(), v.record(v.string(), v.number())]),
      ),
    }),
    contentMode: v.optional(
      v.record(v.string(), v.picklist(["tight", "fit-content"])),
      {},
    ),
  }),
  version: v.number(),
});

const parseStorage = (json: string): StorageShape | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const result = v.safeParse(StorageSchema, parsed);
  if (!result.success) {
    return null;
  }
  const entries = result.output.state.columnSizing[MAP_TAG];
  return {
    state: {
      columnSizing: new Map(entries),
      contentMode: result.output.state.contentMode,
    },
    version: result.output.version,
  };
};

const expectParsed = (raw: string): StorageShape => {
  const result = parseStorage(raw);
  if (result === null) {
    throw new Error("parseStorage returned null");
  }
  return result;
};

describe("Map serialization roundtrip", () => {
  test("empty Map survives roundtrip", () => {
    const data = {
      state: {
        columnSizing: new Map<string, ColumnSizingState>(),
        contentMode: {},
      },
      version: 0,
    };
    const serialized = JSON.stringify(data, replacer);
    const parsed = expectParsed(serialized);

    expect(parsed.state.columnSizing).toBeInstanceOf(Map);
    expect(parsed.state.columnSizing.size).toBe(0);
    expect(parsed.version).toBe(0);
  });

  test("Map with entries survives roundtrip", () => {
    const data = {
      state: {
        columnSizing: new Map<string, ColumnSizingState>([
          ["view-1", { col_a: 200, col_b: 150 }],
          ["view-2", { col_x: 300 }],
        ]),
        contentMode: { "view-1": "fit-content" as const },
      },
      version: 0,
    };
    const serialized = JSON.stringify(data, replacer);
    const parsed = expectParsed(serialized);

    expect(parsed.state.columnSizing).toBeInstanceOf(Map);
    expect(parsed.state.columnSizing.size).toBe(2);
    expect(parsed.state.columnSizing.get("view-1")).toEqual({
      col_a: 200,
      col_b: 150,
    });
    expect(parsed.state.columnSizing.get("view-2")).toEqual({
      col_x: 300,
    });
    expect(parsed.state.contentMode).toEqual({ "view-1": "fit-content" });
  });

  test("wire format uses tagged entries", () => {
    const data = {
      state: {
        columnSizing: new Map([["v1", { a: 100 }]]),
        contentMode: { v1: "tight" as const },
      },
      version: 0,
    };

    const wire: unknown = JSON.parse(JSON.stringify(data, replacer));

    expect(wire).toEqual({
      state: {
        columnSizing: { [MAP_TAG]: [["v1", { a: 100 }]] },
        contentMode: { v1: "tight" },
      },
      version: 0,
    });
  });

  test("returns null for corrupted localStorage data", () => {
    expect(parseStorage("not json at all")).toBeNull();
    expect(parseStorage("{truncated")).toBeNull();
  });

  test("rejects invalid JSON structure", () => {
    expect(parseStorage("{}")).toBeNull();
    expect(parseStorage(JSON.stringify({ state: "bad" }))).toBeNull();
    expect(
      parseStorage(JSON.stringify({ state: { columnSizing: "nope" } })),
    ).toBeNull();
    expect(
      parseStorage(
        JSON.stringify({
          state: {
            columnSizing: { [MAP_TAG]: [[123, "bad"]] },
          },
          version: 0,
        }),
      ),
    ).toBeNull();
  });
});

// The store's `persist` middleware writes on every change, so it needs a
// Storage before the module is evaluated; a Map is enough, and nothing here
// asserts on what was written (the parsing tests above cover that).
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

// `columnSizing` is a Map, and immer only drafts one with this plugin on. The
// app enables it in `router.tsx`, which a unit test does not load.
enableMapSet();

const { useTableStore } =
  await import("@/routes/_protected.workspaces/$workspaceId/-hooks/table-store");

describe("a view's find bar", () => {
  beforeEach(() => {
    useTableStore.setState({ find: {} });
  });

  test("opens unrestricted and empty", () => {
    useTableStore.getState().openFind("v1");

    expect(useTableStore.getState().find["v1"]).toEqual({
      scope: { type: "all" },
      submitted: "",
      typed: "",
    });
  });

  test("keeps what was typed when the shortcut fires again", () => {
    const { openFind, setFindTyped, submitFind } = useTableStore.getState();
    openFind("v1");
    setFindTyped("v1", "lease");
    submitFind("v1");

    openFind("v1");

    expect(useTableStore.getState().find["v1"]?.submitted).toBe("lease");
  });

  test("holds what is typed back until it is submitted", () => {
    const { openFind, setFindTyped, submitFind } = useTableStore.getState();
    openFind("v1");
    setFindTyped("v1", "lea");

    expect(useTableStore.getState().find["v1"]).toMatchObject({
      submitted: "",
      typed: "lea",
    });

    submitFind("v1");

    expect(useTableStore.getState().find["v1"]?.submitted).toBe("lea");
  });

  test("closing resets it, so reopening starts clean", () => {
    const { openFind, setFindTyped, submitFind, closeFind, setFindScope } =
      useTableStore.getState();
    openFind("v1");
    setFindTyped("v1", "lease");
    submitFind("v1");
    setFindScope("v1", { propertyIds: ["p1"], type: "columns" });

    closeFind("v1");
    expect(useTableStore.getState().find["v1"]).toBeUndefined();

    openFind("v1");
    expect(useTableStore.getState().find["v1"]).toEqual({
      scope: { type: "all" },
      submitted: "",
      typed: "",
    });
  });

  test("edits nothing while the bar is closed", () => {
    const { setFindTyped, submitFind, setFindScope } = useTableStore.getState();
    setFindTyped("v1", "lease");
    submitFind("v1");
    setFindScope("v1", { propertyIds: ["p1"], type: "columns" });

    expect(useTableStore.getState().find["v1"]).toBeUndefined();
  });

  test("a view that is gone loses its find with every other per-view record", () => {
    const { openFind, pruneStaleViews } = useTableStore.getState();
    openFind("v1");
    openFind("v2");

    pruneStaleViews(["v2"]);

    expect(Object.keys(useTableStore.getState().find)).toEqual(["v2"]);
  });
});
