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
    title: "resolves identically named expected values by lexical binding",
    source: [
      'test("derived", () => {',
      "  const expected = derive(fx.text);",
      "  expect(detect(fx.text)).toBe(expected);",
      "});",
      'test("literal", () => {',
      '  const expected = "plain";',
      "  expect(detect(fx.text)).toBe(expected);",
      "});",
    ].join("\n"),
    lines: [3],
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
    title: "does not treat non-computed property names as variable references",
    source: [
      "const input = fx.input;",
      'expect(detect(input)).toEqual({ input: "plain" });',
    ].join("\n"),
    lines: [],
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
    title: "allows independent members of a dynamically selected fixture",
    source:
      "expect(parse(FIXTURES[jurisdiction].text)).toEqual(FIXTURES[jurisdiction].expected);",
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
    title: "allows repeated observations anchored elsewhere in the test",
    source: [
      "const firstRead = readFileSync(path.join(fixture.directory, 'failure.json'));",
      "expect(firstRead).toContain('known diagnostic');",
      "expect(readFileSync(path.join(fixture.directory, 'failure.json'))).toBe(firstRead);",
    ].join("\n"),
    lines: [],
  },
  {
    title: "rejects an unanchored repeated observation",
    source: [
      "const firstRead = readFileSync(path.join(fixture.directory, 'failure.json'));",
      "expect(readFileSync(path.join(fixture.directory, 'failure.json'))).toBe(firstRead);",
    ].join("\n"),
    lines: [2],
  },
  {
    title: "allows mirrored array context around an independent oracle",
    source: [
      "expect([row.name, grade(row, wrapped).reason]).toEqual([row.name, row.reason]);",
      "expect([detect(row.country), row.tier]).toEqual([derive(row.country), row.tier]);",
    ].join("\n"),
    lines: [2],
  },
  {
    title: "checks every shared path after mirrored array context",
    source:
      'expect([row.name, detect(row.text), "x"]).toEqual([row.name, derive(row.text), "x"]);',
    lines: [1],
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
    title: "does not accept descendant fixture members as anchors",
    source: [
      "expect(detectLength(fx.text)).toBe(fx.text.length);",
      "expect(detectLength(fx.text)).toBe(deriveLength(fx.text));",
      "expect(detectFirst(fx.items)).toBe(fx.items[0]);",
      "expect(detectFirst(fx.items)).toBe(deriveFirst(fx.items));",
    ].join("\n"),
    lines: [2, 4],
  },
  {
    title: "follows descendant dependencies through aliases and templates",
    source: [
      "const text = fx.text;",
      "const first = fx.items[0];",
      [
        "expect(detectLength(fx.text)).toBe(`",
        ["$", "{", "text.length", "}"].join(""),
        "`);",
      ].join(""),
      "expect(detectLength(fx.text)).toBe(deriveLength(fx.text));",
      "expect(detectFirst(fx.items)).toBe(first);",
      "expect(detectFirst(fx.items)).toBe(deriveFirst(fx.items));",
    ].join("\n"),
    lines: [4, 6],
  },
  {
    title: "follows anchor initializer dependencies",
    source: [
      "const expected = String(fx.text);",
      "expect(detect(fx.text)).toBe(expected);",
      "expect(detect(fx.text)).toBe(derive(fx.text));",
    ].join("\n"),
    lines: [3],
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
  {
    title: "does not accept an anchor from another parameterized test",
    source: [
      'test.each([fx])("literal", () => expect(detect(fx.text)).toBe("plain"));',
      'test.each([fx])("parity", () => expect(detect(fx.text)).toBe(derive(fx.text)));',
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
