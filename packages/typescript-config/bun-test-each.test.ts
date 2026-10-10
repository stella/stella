import { describe, expect, it, test } from "bun:test";

const MODES = ["draft", "final"] as const;
const LABELS: readonly string[] = ["a", "b"];
const PAIRS = [
  ["draft", 1],
  ["final", 2],
] as const;
const GROUPS: readonly (readonly string[])[] = [["a", "b"], ["c"]];
const CASES = [
  { mode: "draft", rank: 1 },
  { mode: "final", rank: 2 },
] as const;

type Mode = (typeof MODES)[number];

describe("readonly each tables", () => {
  test.each(MODES)("test.each accepts an as-const tuple: %s", (mode) => {
    const literal: Mode = mode;
    expect(MODES).toContain(literal);
  });

  test.each(LABELS)("test.each accepts a readonly array: %s", (label) => {
    expect(LABELS).toContain(label);
  });

  it.each(MODES)("it.each accepts an as-const tuple: %s", (mode) => {
    const literal: Mode = mode;
    expect(MODES).toContain(literal);
  });

  it.each(LABELS)("it.each accepts a readonly array: %s", (label) => {
    expect(LABELS).toContain(label);
  });

  test.each(PAIRS)("tuple rows still spread: %s", (mode, rank) => {
    const count: number = rank;
    expect(MODES.indexOf(mode)).toBe(count - 1);
  });

  test.each(GROUPS)("readonly array rows still spread: %s", (...labels) => {
    const spread: readonly string[] = labels;
    expect(GROUPS).toContainEqual(spread);
  });

  test.each(CASES)("object rows arrive whole: %o", ({ mode, rank }) => {
    const literal: Mode = mode;
    expect(MODES.indexOf(literal)).toBe(rank - 1);
  });
});

describe.each(MODES)("describe.each accepts an as-const tuple: %s", (mode) => {
  test("receives the row", () => {
    const literal: Mode = mode;
    expect(MODES).toContain(literal);
  });
});

describe.each(LABELS)("describe.each accepts a readonly array: %s", (label) => {
  test("receives the row", () => {
    expect(LABELS).toContain(label);
  });
});

describe.each(PAIRS)(
  "describe.each tuple rows still spread: %s",
  (mode, rank) => {
    test("receives each column", () => {
      const count: number = rank;
      expect(MODES.indexOf(mode)).toBe(count - 1);
    });
  },
);
