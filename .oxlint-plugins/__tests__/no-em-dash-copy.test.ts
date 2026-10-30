import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (source: string) =>
  lintSingleRule("no-em-dash-copy", source, { sourcePath: "source.tsx" });

test("rejects the glyph in string and template copy", async () => {
  expect(await lint('const label = "Saved — just now";')).toEqual([1]);
  expect(await lint("const label = 'Saved — just now';")).toEqual([1]);
  expect(await lint(`const label = (n: number) => \`\${n} — items\`;`)).toEqual(
    [1],
  );
});

test("rejects the glyph and its entities in JSX", async () => {
  expect(await lint("const p = <p>Draft — not sent</p>;")).toEqual([1]);
  expect(await lint("const p = <p>Draft &mdash; not sent</p>;")).toEqual([1]);
  expect(await lint("const p = <p>Draft &#8212; not sent</p>;")).toEqual([1]);
  expect(await lint("const p = <p>Draft &#x2014; not sent</p>;")).toEqual([1]);
  expect(await lint('const p = <span title="A — B" />;')).toEqual([1]);
  expect(await lint('const p = <span title="A &mdash; B" />;')).toEqual([1]);
});

test("allows the character spelled as data", async () => {
  expect(await lint('const DASHES = ["\\u2014", "\\u2013"];')).toEqual([]);
  expect(await lint("const p = <p>{`\\u2014`}</p>;")).toEqual([]);
  expect(
    await lint('const clean = (t: string) => t.replaceAll(/—/gu, "-");'),
  ).toEqual([]);
});

test("rejects a spaced glyph that separates two pieces of copy", async () => {
  expect(await lint('const p = <p>{label}{" — "}{name}</p>;')).toEqual([1]);
  expect(await lint('const tip = [a, b].join(" — ");')).toEqual([1]);
  expect(await lint(`const title = \`\${a} — \${b}\`;`)).toEqual([1]);
});

test("rejects a marker-shaped segment when the template has interpolations", async () => {
  expect(await lint(`const title = \`\${left}—\${right}\`;`)).toEqual([1]);
  expect(await lint(`const title = \`—\${right}\`;`)).toEqual([1]);
  expect(await lint(`const title = \`\${left}—\`;`)).toEqual([1]);
});

test("allows the lone empty-cell marker", async () => {
  expect(await lint('const cell = (v: string | null) => v ?? "—";')).toEqual(
    [],
  );
  expect(await lint("const cell = <span>—</span>;")).toEqual([]);
  expect(await lint("const cell = <span> &mdash; </span>;")).toEqual([]);
  expect(await lint("const cell = `—`;")).toEqual([]);
  expect(await lint('const p = <input placeholder="—" />;')).toEqual([]);
});

test("allows en dash ranges, entities outside JSX and comments", async () => {
  expect(await lint('const range = "2019–2024";')).toEqual([]);
  expect(await lint('const label = "Uloženo – právě teď";')).toEqual([]);
  expect(await lint('const entity = "&mdash;";')).toEqual([]);
  expect(await lint('// draft — not sent\nconst label = "Draft";')).toEqual([]);
  expect(await lint("const p = <p>{/* draft — not sent */}Draft</p>;")).toEqual(
    [],
  );
});
