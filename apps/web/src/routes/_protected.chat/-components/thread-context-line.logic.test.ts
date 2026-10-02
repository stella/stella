import { describe, expect, test } from "bun:test";

import { layoutThreadContext } from "./thread-context-line.logic";

const named = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);

describe("layoutThreadContext", () => {
  test("no context renders no line", () => {
    const layout = layoutThreadContext({
      fileCount: 0,
      files: [],
      matterCount: 0,
      matters: [],
    });

    expect(layout.hasContext).toBe(false);
    expect(layout.overflowCount).toBe(0);
    expect(layout.inline).toEqual({ files: [], matters: [] });
  });

  test("a small context shows every item inline and no badge", () => {
    const layout = layoutThreadContext({
      fileCount: 2,
      files: named("f", 2),
      matterCount: 1,
      matters: named("m", 1),
    });

    expect(layout.inline).toEqual({ files: ["f1", "f2"], matters: ["m1"] });
    expect(layout.hidden).toEqual({ files: [], matters: [] });
    expect(layout.overflowCount).toBe(0);
    expect(layout.hasContext).toBe(true);
  });

  test("shows at most two matters and two files, folding the rest into one count", () => {
    const layout = layoutThreadContext({
      fileCount: 5,
      files: named("f", 5),
      matterCount: 3,
      matters: named("m", 3),
    });

    expect(layout.inline).toEqual({
      files: ["f1", "f2"],
      matters: ["m1", "m2"],
    });
    expect(layout.hidden).toEqual({
      files: ["f3", "f4", "f5"],
      matters: ["m3"],
    });
    expect(layout.overflowCount).toBe(4);
    expect(layout.unnamedCount).toBe(0);
  });

  test("many files never crowd out the matters", () => {
    const layout = layoutThreadContext({
      fileCount: 40,
      files: named("f", 8),
      matterCount: 1,
      matters: named("m", 1),
    });

    expect(layout.inline.matters).toEqual(["m1"]);
    expect(layout.inline.files).toEqual(["f1", "f2"]);
  });

  test("a kind under its budget does not lend slots to the other", () => {
    const layout = layoutThreadContext({
      fileCount: 4,
      files: named("f", 4),
      matterCount: 0,
      matters: [],
    });

    expect(layout.inline.files).toEqual(["f1", "f2"]);
    expect(layout.overflowCount).toBe(2);
  });

  test("counts items the server found beyond the preview it named", () => {
    const layout = layoutThreadContext({
      fileCount: 30,
      files: named("f", 8),
      matterCount: 12,
      matters: named("m", 8),
    });

    expect(layout.hidden.files).toHaveLength(6);
    expect(layout.hidden.matters).toHaveLength(6);
    expect(layout.unnamedCount).toBe(4 + 22);
    expect(layout.overflowCount).toBe(12 + 30 - 4);
  });

  test("a count below the named preview never yields a negative overflow", () => {
    const layout = layoutThreadContext({
      fileCount: 0,
      files: named("f", 3),
      matterCount: 1,
      matters: named("m", 3),
    });

    expect(layout.unnamedCount).toBe(0);
    expect(layout.overflowCount).toBe(2);
  });

  test("honours custom inline budgets, clamping negatives to zero", () => {
    const layout = layoutThreadContext(
      {
        fileCount: 2,
        files: named("f", 2),
        matterCount: 2,
        matters: named("m", 2),
      },
      { maxInlineFiles: -1, maxInlineMatters: 1 },
    );

    expect(layout.inline).toEqual({ files: [], matters: ["m1"] });
    expect(layout.overflowCount).toBe(3);
  });
});
