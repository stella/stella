import { describe, expect, test } from "bun:test";

import {
  buildRenderPlan,
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
