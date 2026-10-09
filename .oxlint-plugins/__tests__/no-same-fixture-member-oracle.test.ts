import { expect, test } from "bun:test";

import { runSingleRule } from "./lint-single-rule.ts";

const cases = [
  {
    title: "reports a detector compared with an oracle over the same member",
    source: "expect(detect(fx.text)).toBe(derive(fx.text));",
    lines: [1],
  },
  {
    title: "follows a one-hop alias",
    source:
      "const text = fx.text;\nexpect(detect(text)).toEqual({ value: fx.text });",
    lines: [2],
  },
  {
    title: "allows literal, golden, and independent fixture expectations",
    source: [
      'expect(detect(fx.text)).toBe("plain");',
      "expect(detect(fx.text)).toBe(fx.expected);",
      "expect(render(fx.input)).toMatchObject(golden);",
    ].join("\n"),
    lines: [],
  },
  {
    title: "allows identity and span integrity assertions",
    source: [
      "expect(fx.text).toBe(fx.text);",
      "expect({ start: 0, end: fx.text.length }).toEqual({ start: 0, end: fx.text.length });",
    ].join("\n"),
    lines: [],
  },
  {
    title: "allows parity anchored by a literal assertion",
    source: [
      'expect(detect(fx.text)).toBe("plain");',
      "expect(detect(fx.text)).toBe(derive(fx.text));",
    ].join("\n"),
    lines: [],
  },
  {
    title: "does not accept a negated assertion as an anchor",
    source: [
      'test("detector", () => {',
      '  expect(detect(fx.text)).not.toBe("unrelated");',
      "  expect(detect(fx.text)).toBe(derive(fx.text));",
      "});",
    ].join("\n"),
    lines: [3],
  },
  {
    title: "does not accept an anchor from another test",
    source: [
      'test("literal", () => expect(detect(fx.text)).toBe("plain"));',
      'test("parity", () => expect(detect(fx.text)).toBe(derive(fx.text)));',
    ].join("\n"),
    lines: [2],
  },
];

test.each(cases)(
  "no-same-fixture-member-oracle: $title",
  async ({ source, lines }) => {
    expect(
      (
        await runSingleRule("no-same-fixture-member-oracle", source, {
          sourcePath: "subject.test.ts",
        })
      ).lines,
    ).toEqual(lines);
  },
);
