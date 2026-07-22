import { describe, expect, test } from "bun:test";

import { buildOutputFlags } from "./output-flags.js";

describe("buildOutputFlags", () => {
  test("all output modes stay one optional shared flag set", () => {
    const flags = buildOutputFlags();

    expect(Object.keys(flags).sort()).toEqual(["json", "output", "table"]);
    expect(flags.output.brief).toContain("json | table | jsonl");
    expect(flags.json.withNegated).toBe(false);
    expect(flags.table.withNegated).toBe(false);
  });
});
