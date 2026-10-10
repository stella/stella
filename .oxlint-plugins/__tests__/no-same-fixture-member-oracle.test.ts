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
    title: "follows an expected-value alias inside an object assertion",
    source:
      "const expected = derive(fx.input);\nexpect({ value: detect(fx.input) }).toEqual({ value: expected });",
    lines: [2],
  },
  {
    title: "follows chained expected-value aliases inside an array assertion",
    source:
      "const derived = derive(fx.input);\nconst expected = derived;\nexpect([detect(fx.input)]).toEqual([expected]);",
    lines: [3],
  },
  {
    title:
      "does not treat a domain name containing a fixture word as a fixture",
    source: [
      "expect(detect(caseLawDecisions.id)).toEqual([derive(caseLawDecisions.id)]);",
      "expect(detect(CASE_LAW_REPORTER.OPERATOR)).toEqual({ value: derive(CASE_LAW_REPORTER.OPERATOR) });",
      "expect(detect(throwable.text)).toBe(derive(throwable.text));",
    ].join("\n"),
    lines: [],
  },
  {
    title: "treats a fixture noun at the head of a compound root as a fixture",
    source: [
      "expect(detect(testCase.text)).toBe(derive(testCase.text));",
      "expect(detect(input_rows.text)).toBe(derive(input_rows.text));",
    ].join("\n"),
    lines: [1, 2],
  },
  {
    title: "treats an awaited state read as an observation, not an oracle",
    source: [
      "const before = await fixture.row(listing.id);",
      "await fixture.walk();",
      "expect(await fixture.row(listing.id)).toMatchObject({ status, attempts: before?.attempts });",
      "const own = (await decisionBy(fixture.sourceId, 'a')).key;",
      "expect(keysUnder(fixture.sourceId, id)).toEqual([own]);",
    ].join("\n"),
    lines: [],
  },
  {
    title: "still traces an oracle awaited on the expected side",
    source: [
      "const expected = await derive(fx.input);",
      "expect(await detect(fx.input)).toEqual([expected]);",
      "expect(detect(fx.text)).toEqual([await wrap(derive(fx.text))]);",
    ].join("\n"),
    lines: [2, 3],
  },
  {
    title: "reports an awaited oracle as the direct expectation",
    source:
      "test('async', async () => { expect(await detect(fx.input)).toBe(await derive(fx.input)); });",
    lines: [1],
  },
  {
    title: "allows an awaited state read compared before and after an action",
    source: [
      "test('kept', async () => {",
      "  const before = await readKey(db, fixture.keyId);",
      "  await rotate(fixture.keyId);",
      "  expect(await readKey(db, fixture.keyId)).toEqual(before);",
      "});",
    ].join("\n"),
    lines: [],
  },
  {
    title: "reports an awaited derivation behind an alias",
    source: [
      "test('async', async () => {",
      "  const expected = await derive(fx.input);",
      "  expect(await detect(fx.input)).toEqual(expected);",
      "});",
    ].join("\n"),
    lines: [3],
  },
  {
    title: "follows a standalone chained expected alias",
    source:
      "const derived = derive(fx.input);\nconst expected = derived;\nexpect(detect(fx.input)).toBe(expected);",
    lines: [3],
  },
  {
    title: "terminates on a cyclic expected alias",
    source: "const a = b;\nconst b = a;\nexpect(detect(fx.input)).toBe(a);",
    lines: [],
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
