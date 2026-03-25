import { describe, expect, test } from "bun:test";
import * as v from "valibot";

const MAP_TAG = "__map";

const replacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Map) {
    return { [MAP_TAG]: [...value.entries()] };
  }
  return value;
};

type ColumnSizingState = Record<string, number>;

type StorageShape = {
  state: { columnSizing: Map<string, ColumnSizingState> };
  version: number;
};

const StorageSchema = v.object({
  state: v.object({
    columnSizing: v.object({
      [MAP_TAG]: v.array(
        v.tuple([v.string(), v.record(v.string(), v.number())]),
      ),
    }),
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
    state: { columnSizing: new Map(entries) },
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
      state: { columnSizing: new Map<string, ColumnSizingState>() },
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
  });

  test("wire format uses tagged entries", () => {
    const data = {
      state: {
        columnSizing: new Map([["v1", { a: 100 }]]),
      },
      version: 0,
    };
    const wire: unknown = JSON.parse(JSON.stringify(data, replacer));

    expect(wire).toEqual({
      state: {
        columnSizing: { [MAP_TAG]: [["v1", { a: 100 }]] },
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
