import { expect, test } from "bun:test";

import config from "../../oxlint.config.ts";
import {
  readScopes,
  scopeMatches,
} from "../../scripts/oxlint-config-scopes.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

const RULE_ID = "no-em-dash-copy/no-em-dash-copy";

const lint = async (source: string) =>
  lintSingleRule("no-em-dash-copy", source, { sourcePath: "source.tsx" });

/** The severity the production config gives the rule for `file`. */
const severityFor = (file: string): unknown => {
  let severity: unknown;
  for (const scope of readScopes(config)) {
    if (scopeMatches(scope, file) && Object.hasOwn(scope.rules, RULE_ID)) {
      severity = scope.rules[RULE_ID];
    }
  }
  return severity;
};

test("checks product copy in the apps and UI packages", () => {
  const copy = [
    "apps/web/src/components/app-sidebar.tsx",
    "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/flows/run-detail.tsx",
    "apps/desktop/src/clipboard/ClipboardApp.tsx",
    "apps/landing/src/components/react/AnonymizeLiveDemo.tsx",
    "packages/mcp-apps/src/case-law-results/view.tsx",
    "packages/ui/src/data-table/table.tsx",
  ];
  expect(copy.map((file) => [file, severityFor(file)])).toEqual(
    copy.map((file) => [file, "error"]),
  );
});

test("skips text written for a model, an operator or a parser", () => {
  const notCopy = [
    "apps/api/src/handlers/chat/chat-prompt.ts",
    "apps/api/src/lib/case-law/analysis-prompt.ts",
    "apps/api/src/handlers/case-law/ingestion/adapters/cz-nss.ts",
    "apps/api/src/handlers/lists/sample-case/sample-case.data.ts",
    "apps/api/src/mcp/template-field-reference.ts",
    "packages/agent-input/src/absent.ts",
    "packages/api-contract/src/us-reporter-citation.ts",
    "packages/business-registries/src/orsr/parse.ts",
    "packages/decision-reader/src/fallback-legal-anchors.ts",
    "packages/legal-atlas/src/provision-citation-resolve.ts",
    "packages/cli/src/generate-skill.ts",
    "packages/scripts/src/model-catalog-upstream.ts",
    "apps/web/src/routes/dev/-components/ui-playground.tsx",
    "apps/web/src/runtime.ts",
    "apps/web/src/components/render-storm-canary.tsx",
  ];
  expect(notCopy.map((file) => [file, severityFor(file)])).toEqual(
    notCopy.map((file) => [file, undefined]),
  );
});

test("skips console diagnostics but not copy logged from a variable", async () => {
  expect(
    await lint(
      [
        'console.trace("[stella] route rejected — redirecting. URL:", url);',
        `console.warn(\`chunk threw — \${failure}\`);`,
        'const label = "Saved — just now";',
        "console.log(label);",
        'console.error(() => "Saved — just now");',
      ].join("\n"),
    ),
  ).toEqual([3, 5]);
});

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
