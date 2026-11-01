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

for (const marker of [
  "—",
  "&mdash;",
  "&#8212;",
  "&#x2014;",
  "{'—'}",
  "{`—`}",
]) {
  test(`rejects ${marker} beside rendered JSX siblings`, async () => {
    const children = [
      `{label}${marker}{name}`,
      `{label}${marker}`,
      `${marker}{name}`,
      `before${marker}`,
      `${marker}after`,
    ];
    const sources = children.flatMap((content) => [
      `const p = <p>${content}</p>;`,
      `const p = <>${content}</>;`,
    ]);
    const results = await Promise.all(
      sources.map(async (source) => await lint(source)),
    );
    for (const result of results) {
      expect(result).toEqual([1]);
    }
  });
  test(`allows ${marker} as the sole rendered JSX content`, async () => {
    expect(await lint(`const p = <td>${marker}</td>;`)).toEqual([]);
    expect(
      await lint(`const p = <td>  {/* marker */}${marker}  </td>;`),
    ).toEqual([]);
  });
}

test("rejects lone string markers used to compose copy", async () => {
  const sources = [
    'const title = left + "—" + right;',
    'const title = "—" + right;',
    "const title = left + `—`;",
    'const title = ("—" as string) + right;',
    'const title = parts.join("—");',
    'const title = "—".concat(right);',
    'const p = <p>{label}{name ?? "—"}</p>;',
    'const p = <p>{ok ? "—" : name}{label}</p>;',
    'const p = <p>{("—" satisfies string)}{label}</p>;',
    'const p = <p>{(log(), "—")}{label}</p>;',
    "const p = <p>{label} — {name}</p>;",
    "const p = <p>{a}—</p>;",
    "const p = <p>—{b}</p>;",
    "const p = <p><>—</>{label}</p>;",
    'const p = <input placeholder={"—" + label} />;',
  ];
  const results = await Promise.all(
    sources.map(async (source) => await lint(source)),
  );
  for (const result of results) {
    expect(result).toEqual([1]);
  }
});

test("keeps sole-content markers local to their containing element", async () => {
  const sources = [
    "const p = <tr><td>—</td><td>{amount}</td></tr>;",
    "const p = <tr><td>{'—'}</td><td>{amount}</td></tr>;",
    'const p = <td>{ok ? "—" : value}</td>;',
    'const p = <td>{value ?? "—"}</td>;',
    'const p = <td>{("—" satisfies string)}</td>;',
    'const p = <td>{("—")}</td>;',
    "const p = <td><>—</></td>;",
  ];
  const results = await Promise.all(
    sources.map(async (source) => await lint(source)),
  );
  for (const result of results) {
    expect(result).toEqual([]);
  }
});
