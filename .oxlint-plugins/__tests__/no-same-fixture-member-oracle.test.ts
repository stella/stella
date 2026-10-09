import { expect, test } from "bun:test";

import { lintRuleAcrossFiles, runSingleRule } from "./lint-single-rule.ts";

const cases = [
  {
    title: "follows a one-hop expected-value alias",
    source:
      "const expected = derive(fx.input);\nexpect(detect(fx.input)).toBe(expected);",
    lines: [2],
  },
  {
    title: "inspects computed calls nested in object assertions",
    source:
      "expect({ value: detect(fx.input) }).toEqual({ value: derive(fx.input) });",
    lines: [1],
  },
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
    title: "does not accept anchors that depend on the shared fixture member",
    source: [
      "const text = fx.text;",
      "expect(detect(fx.text)).toBe(fx.text);",
      "expect(detect(fx.text)).toBe(derive(fx.text));",
      "expect(detect(fx.text)).toBe(text);",
      "expect(detect(fx.text)).toBe(derive(fx.text));",
      [
        "expect(detect(fx.text)).toBe(`",
        ["$", "{", "fx.text", "}"].join(""),
        "`);",
      ].join(""),
      "expect(detect(fx.text)).toBe(derive(fx.text));",
    ].join("\n"),
    lines: [3, 5, 7],
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

test("no-same-fixture-member-oracle resets state between files", async () => {
  expect(
    await lintRuleAcrossFiles("no-same-fixture-member-oracle", {
      "a.test.ts": 'expect(detect(fx.text)).toBe("plain");',
      "b.test.ts": "expect(detect(fx.text)).toBe(derive(fx.text));",
    }),
  ).toEqual({ "a.test.ts": [], "b.test.ts": [1] });
});
