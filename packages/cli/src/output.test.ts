import { describe, expect, test } from "bun:test";

import {
  buildRenderPlan,
  displayWidth,
  renderResult,
  selectFormat,
  type Writers,
} from "./output.js";

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  const writers: Writers = {
    stdout: (t) => {
      out.push(t);
    },
    stderr: (t) => {
      err.push(t);
    },
  };
  return { out, err, writers };
};

describe("selectFormat (S4)", () => {
  test("table on a TTY, JSON off a TTY by default", () => {
    expect(selectFormat({ flags: {}, isTTY: true })).toBe("table");
    expect(selectFormat({ flags: {}, isTTY: false })).toBe("json");
  });

  test("--output / --json / --table override the TTY default", () => {
    expect(selectFormat({ flags: { output: "json" }, isTTY: true })).toBe(
      "json",
    );
    expect(selectFormat({ flags: { json: true }, isTTY: true })).toBe("json");
    expect(selectFormat({ flags: { table: true }, isTTY: false })).toBe(
      "table",
    );
  });

  test("--output jsonl is honored on and off a TTY", () => {
    expect(selectFormat({ flags: { output: "jsonl" }, isTTY: true })).toBe(
      "jsonl",
    );
    expect(selectFormat({ flags: { output: "jsonl" }, isTTY: false })).toBe(
      "jsonl",
    );
  });
});

describe("renderResult: jsonl (spec 049 §3)", () => {
  test("a page emits one item per line to stdout, nothing extra on stderr", () => {
    const { out, err, writers } = capture();
    const plan = buildRenderPlan({
      payload: { items: [{ id: 1 }, { id: 2 }], nextCursor: null },
      itemsKey: "items",
      windowedText: false,
      singleReadActive: false,
      columns: undefined,
    });
    renderResult({ plan, format: "jsonl", writers, allActive: false });
    expect(out.join("")).toBe('{"id":1}\n{"id":2}\n');
    expect(err.join("")).toBe("");
  });

  test("a single object emits exactly one line", () => {
    const { out, writers } = capture();
    const plan = buildRenderPlan({
      payload: { ok: true },
      itemsKey: undefined,
      windowedText: false,
      singleReadActive: false,
      columns: undefined,
    });
    renderResult({ plan, format: "jsonl", writers, allActive: false });
    expect(out.join("")).toBe('{"ok":true}\n');
  });
});

describe("buildRenderPlan (S4)", () => {
  test("detects a page envelope by its itemsKey array", () => {
    const plan = buildRenderPlan({
      payload: { matters: [{ id: "m1" }], nextCursor: "c1" },
      itemsKey: "matters",
      windowedText: false,
      singleReadActive: false,
      columns: undefined,
    });
    expect(plan.kind).toBe("page");
    if (plan.kind === "page") {
      expect(plan.items).toHaveLength(1);
      expect(plan.nextCursor).toBe("c1");
    }
  });

  test("a single-read payload (no items array) renders as a single object", () => {
    // list_matters with matter_id returns {matter, overview,...}: no `matters`.
    const plan = buildRenderPlan({
      payload: {
        matter: { id: "m1" },
        overview: {},
        contacts: [],
        members: [],
      },
      itemsKey: "matters",
      windowedText: false,
      singleReadActive: false,
      columns: undefined,
    });
    expect(plan.kind).toBe("single");
  });

  test("windowed-text extracts text and nextCursor", () => {
    const plan = buildRenderPlan({
      payload: { text: "hello", nextCursor: "next" },
      itemsKey: undefined,
      windowedText: true,
      singleReadActive: false,
      columns: undefined,
    });
    expect(plan).toEqual({
      kind: "windowed-text",
      text: "hello",
      nextCursor: "next",
    });
  });
});

describe("renderResult (S4)", () => {
  test("table mode renders rows and emits a stderr cursor hint", () => {
    const { out, err, writers } = capture();
    renderResult({
      plan: {
        kind: "page",
        itemsKey: "matters",
        items: [{ id: "m1", name: "Acme" }],
        payload: {},
        nextCursor: "c9",
        columns: undefined,
      },
      format: "table",
      writers,
      allActive: false,
    });
    expect(out.join("")).toContain("id");
    expect(out.join("")).toContain("m1");
    expect(err.join("")).toBe("more: --cursor c9\n");
  });

  test("json mode prints the parsed payload and no cursor hint under --all", () => {
    const { out, err, writers } = capture();
    renderResult({
      plan: {
        kind: "page",
        itemsKey: "matters",
        items: [{ id: "m1" }],
        payload: { matters: [{ id: "m1" }], nextCursor: null },
        nextCursor: null,
        columns: undefined,
      },
      format: "json",
      writers,
      allActive: true,
    });
    expect(JSON.parse(out.join(""))).toEqual({
      matters: [{ id: "m1" }],
      nextCursor: null,
    });
    expect(err.join("")).toBe("");
  });

  test("windowed-text prints raw text", () => {
    const { out, writers } = capture();
    renderResult({
      plan: { kind: "windowed-text", text: "raw body", nextCursor: null },
      format: "table",
      writers,
      allActive: false,
    });
    expect(out.join("")).toBe("raw body\n");
  });
});

describe("renderResult: table fitting and flattening", () => {
  const page = (items: readonly unknown[]) =>
    buildRenderPlan({
      payload: { items, nextCursor: null },
      itemsKey: "items",
      windowedText: false,
      singleReadActive: false,
      columns: undefined,
    });

  test("an inferred column that is empty on every row is dropped", () => {
    const { out, writers } = capture();
    renderResult({
      plan: page([
        { id: "a", tags: [], color: null, name: "One" },
        { id: "b", tags: [], color: null, name: "Two" },
      ]),
      format: "table",
      writers,
      allActive: false,
    });
    const header = out.join("").split("\n")[0] ?? "";
    expect(header).toContain("id");
    expect(header).toContain("name");
    expect(header).not.toContain("tags");
    expect(header).not.toContain("color");
  });

  test("scalar arrays render as a comma list, not JSON", () => {
    const { out, writers } = capture();
    renderResult({
      plan: page([{ id: "a", tags: ["urgent", "client"] }]),
      format: "table",
      writers,
      allActive: false,
    });
    expect(out.join("")).toContain("urgent, client");
  });

  test("rows are fitted to the terminal width with an ellipsis", () => {
    const { out, writers } = capture();
    renderResult({
      plan: page([{ id: "a", headline: "x".repeat(200) }]),
      format: "table",
      writers,
      allActive: false,
      width: 40,
    });
    const lines = out.join("").trimEnd().split("\n");
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
    expect(lines.at(-1)).toContain("\u2026");
  });

  test("without a width nothing is truncated", () => {
    const { out, writers } = capture();
    renderResult({
      plan: page([{ id: "a", headline: "x".repeat(200) }]),
      format: "table",
      writers,
      allActive: false,
    });
    expect(out.join("")).toContain("x".repeat(200));
  });

  test("an empty nested record keeps its key instead of vanishing", () => {
    const { out, writers } = capture();
    renderResult({
      plan: buildRenderPlan({
        payload: { id: "m1", meta: {} },
        itemsKey: undefined,
        windowedText: false,
        singleReadActive: true,
        columns: undefined,
      }),
      format: "table",
      writers,
      allActive: false,
    });
    expect(out.join("")).toContain("meta");
    expect(out.join("")).toContain("{}");
  });

  test("a single object flattens one level of nesting to dotted keys", () => {
    const { out, writers } = capture();
    renderResult({
      plan: buildRenderPlan({
        payload: {
          matter: { id: "m1", name: "Probe" },
          overview: { entityCount: 3 },
          members: [{ userId: "u1" }],
        },
        itemsKey: undefined,
        windowedText: false,
        singleReadActive: true,
        columns: undefined,
      }),
      format: "table",
      writers,
      allActive: false,
    });
    const text = out.join("");
    expect(text).toContain("matter.name");
    expect(text).toContain("Probe");
    expect(text).toContain("overview.entityCount");
    expect(text).not.toContain('{"id":"m1"');
  });
});

describe("displayWidth and Unicode-aware truncation", () => {
  test("counts terminal cells, not UTF-16 code units", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("\u6cd5\u5f8b")).toBe(4);
    expect(displayWidth("caf\u00e9")).toBe(4);
    expect(displayWidth("e\u0301")).toBe(1);
    expect(displayWidth("\u{1F4C4}")).toBe(2);
  });

  test("a CJK cell is cut on a character boundary and stays within the column", () => {
    const { out, writers } = capture();
    renderResult({
      plan: buildRenderPlan({
        payload: {
          items: [{ id: "a", name: "\u6cd5\u5f8b".repeat(30) }],
          nextCursor: null,
        },
        itemsKey: "items",
        windowedText: false,
        singleReadActive: false,
        columns: undefined,
      }),
      format: "table",
      writers,
      allActive: false,
      width: 30,
    });
    for (const line of out.join("").trimEnd().split("\n")) {
      expect(displayWidth(line)).toBeLessThanOrEqual(30);
      expect(line).not.toContain("\uFFFD");
    }
  });
});
