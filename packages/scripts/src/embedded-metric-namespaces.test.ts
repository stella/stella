import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  ALLOWED_EMBEDDED_METRIC_NAMESPACES,
  EMBEDDED_METRIC_NAMESPACE_GUARD,
  inspectEmbeddedMetricNamespaces,
} from "../../../scripts/embedded-metric-namespaces.ts";
import { guardEnforcesLine } from "../../../scripts/guard-rollouts.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const legacyNamespace = JSON.stringify("Stella/Api");
const caseLawNamespace = JSON.stringify("Stella/CaseLaw");
const unlistedNamespace = JSON.stringify("Stella/Unlisted");

// timeout: Parsing every application and package source scales with repository size.
test("application and package EMF namespaces have declared consumers", () => {
  const violations: string[] = [];
  const namespaces = new Set<string>();
  for (const file of new Bun.Glob(
    "{apps,packages}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
  ).scanSync({ cwd: root, onlyFiles: true })) {
    if (
      /(?:^|\/)(?:node_modules|dist|build|target|__fixtures__|__tests__)\//u.test(
        file,
      ) ||
      /\.(?:test|spec|fixture)\.[^.]+$/u.test(file) ||
      file.endsWith(".d.ts")
    ) {
      continue;
    }
    const source = readFileSync(path.join(root, file), "utf-8");
    const result = inspectEmbeddedMetricNamespaces(file, source);
    for (const namespace of result.namespaces) {
      if (Object.hasOwn(ALLOWED_EMBEDDED_METRIC_NAMESPACES, namespace)) {
        namespaces.add(namespace);
      }
    }
    violations.push(
      ...result.violations
        .filter(({ line }) =>
          guardEnforcesLine({
            guard: EMBEDDED_METRIC_NAMESPACE_GUARD,
            file,
            line,
          }),
        )
        .map(({ line, namespace }) => `${file}:${line}: ${namespace}`),
    );
  }
  expect(violations).toEqual([]);
  expect(namespaces).toEqual(
    new Set(Object.keys(ALLOWED_EMBEDDED_METRIC_NAMESPACES)),
  );
}, 30_000);

for (const namespace of Object.keys(ALLOWED_EMBEDDED_METRIC_NAMESPACES)) {
  test(`a declared consumer permits ${namespace}`, () => {
    const source = `const record = { _aws: { CloudWatchMetrics: [{ Namespace: ${JSON.stringify(namespace)}, Dimensions: [[]], Metrics: [{ Name: "Example", Unit: "Count" }] }] }, Example: 1 };`;
    const result = inspectEmbeddedMetricNamespaces("example.ts", source);
    expect(result.namespaces).toEqual([namespace]);
    expect(result.violations).toEqual([]);
  });
}

for (const source of [
  `const record = { _aws: { CloudWatchMetrics: [{ Namespace: ${legacyNamespace} }] } };`,
  `const record = { _aws: { CloudWatchMetrics: [{ Namespace: ${unlistedNamespace} }] } };`,
  `const NAMESPACE = ${legacyNamespace}; const record = { _aws: { CloudWatchMetrics: [{ Namespace: NAMESPACE }] } };`,
  `const record = { _aws: { ["CloudWatchMetrics"]: [{ ["Namespace"]: ${legacyNamespace} }] } };`,
  `const record = { _aws: { \\u0043loudWatchMetrics: [{ Namespace: ${legacyNamespace} }] } };`,
  "const record = { _aws: { CloudWatchMetrics: [{ Namespace: getNamespace() }] } };",
  "const record = { _aws: { CloudWatchMetrics: directives } };",
  "const record = { _aws: { CloudWatchMetrics: [...directives] } };",
  "const record = { _aws: { CloudWatchMetrics: [{ ...directive }] } };",
  `const record = { _aws: { CloudWatchMetrics: [{ Namespace: ${caseLawNamespace}, ...directive }] } };`,
  `const record = { _aws: { CloudWatchMetrics: [{ Namespace: ${caseLawNamespace}, Namespace: ${legacyNamespace} }] } };`,
  `const record = { _aws: { CloudWatchMetrics: [{ Namespace: ${caseLawNamespace}, [key]: value }] } };`,
  `const NAMESPACE = ${caseLawNamespace}; function emit(NAMESPACE) { return { _aws: { CloudWatchMetrics: [{ Namespace: NAMESPACE }] } }; }`,
]) {
  test(`undeclared or unresolved EMF namespaces are rejected: ${source}`, () => {
    expect(
      inspectEmbeddedMetricNamespaces("example.ts", source).violations.length,
    ).toBeGreaterThan(0);
  });
}

test("static module namespace constants resolve without treating comments as directives", () => {
  const source = [
    `const NAMESPACE = ${caseLawNamespace} as const;`,
    `// CloudWatchMetrics: [{ Namespace: ${legacyNamespace} }]`,
    "const record = { _aws: { CloudWatchMetrics: [{ Namespace: NAMESPACE }] } };",
  ].join("\n");
  const result = inspectEmbeddedMetricNamespaces("example.ts", source);
  expect(result.namespaces).toEqual(["Stella/CaseLaw"]);
  expect(result.violations).toEqual([]);
});
