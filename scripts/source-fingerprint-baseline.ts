// Enumerate the members of the source-fingerprint guard and hold them to a
// shrink-only, reasoned baseline (scripts/source-fingerprint-baseline.json).
//
// Three sections, each an exact set keyed without line numbers:
//
//   drivers  `<registration>::<driver>`: a registered case-law source whose
//            enrolled fixture builds a decision whose `rawHash` is not
//            `sourceFingerprint` over what it stores. Measured by
//            apps/api/src/handlers/case-law/ingestion/adapters/source-fingerprint-guard.test.ts,
//            which fails on a new or a stale member.
//   files    an adapter file the `raw-hash-from-source-fingerprint` rule
//            exempts: it still writes `rawHash` without the owner. Measured
//            here by running the rule in census mode.
//   writers  `<file>::<kind>::<name>`: a write of a row keyed by an external
//            id (`externalSource` + `externalId`) without the change marker,
//            or a dedupe key built from an external id without one. Measured
//            here by a TypeScript AST scan, together with the schema check
//            that every table with an `external_id` column declares a change
//            marker.
//
// Modes:
//   bun scripts/source-fingerprint-baseline.ts --check [--base <ref>]
//   bun scripts/source-fingerprint-baseline.ts --write
//   bun scripts/source-fingerprint-baseline.ts --self-test
//
// `--write` regenerates every section from the tree, keeps the reasons of
// surviving rows, and fills a generated reason for a new one; the membership
// check then refuses any row the base does not already have.

import { panic } from "better-result";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";

import { BASELINE_PATHS } from "./baseline-paths.ts";
import { addedEntries, runLedgerMembershipGuard } from "./ledger-membership.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const BASELINE = BASELINE_PATHS.sourceFingerprint;
const RULE = "raw-hash-from-source-fingerprint";
const ADAPTERS_DIR = "apps/api/src/handlers/case-law/ingestion/adapters";
const API_SOURCE_DIR = "apps/api/src";
const SCHEMA_DIR = "apps/api/src/db/schema";
const GUARD_TEST =
  "src/handlers/case-law/ingestion/adapters/source-fingerprint-guard.test.ts";
const CENSUS_OUT_ENV = "SOURCE_FINGERPRINT_CENSUS_OUT";

const REASONED = v.record(v.string(), v.pipe(v.string(), v.nonEmpty()));
const BASELINE_SCHEMA = v.object({
  comment: v.string(),
  drivers: REASONED,
  files: REASONED,
  writers: REASONED,
});
type Baseline = v.InferOutput<typeof BASELINE_SCHEMA>;
const SECTIONS = ["drivers", "files", "writers"] as const;
type Section = (typeof SECTIONS)[number];

const DRIVER_ROWS = v.array(
  v.object({ key: v.string(), reason: v.pipe(v.string(), v.nonEmpty()) }),
);

const LINT_OUTPUT = v.object({
  diagnostics: v.array(v.object({ code: v.string(), filename: v.string() })),
});

const FILE_REASON =
  "Writes rawHash without sourceFingerprint; migrate each site to the owner, then drop this row.";

/** Names the change marker a row keyed by an external id must carry. */
const CHANGE_MARKERS = new Set([
  "externalChangeKey",
  "contentHash",
  "sourceFingerprint",
  "rawHash",
]);
const CHANGE_MARKER_COLUMNS = new Set([
  "external_change_key",
  "content_hash",
  "raw_hash",
  "source_hash",
]);

export const WRITER_REASONS = {
  "external-id-write":
    "Writes a row keyed by an external id without the change marker; store and compare one on upsert.",
  "external-id-dedupe-key":
    "Builds a dedupe key from an external id alone; include the change marker so a changed record notifies again.",
  "external-id-table":
    "Declares an external_id column without a change-marker column; add one and compare it on upsert.",
} as const;
type WriterKind = keyof typeof WRITER_REASONS;

export const parseBaseline = (text: string, label: string): Baseline => {
  const parsed = v.safeParse(BASELINE_SCHEMA, JSON.parse(text));
  return parsed.success
    ? parsed.output
    : panic(`${label} must hold reasoned drivers, files and writers`);
};

/** Membership keys across sections, prefixed so sections cannot trade rows. */
export const ledgerKeys = (baseline: Baseline): string[] =>
  SECTIONS.flatMap((section) =>
    Object.keys(baseline[section]).map((key) => `${section}:${key}`),
  );

// ── writers: external-id rows and dedupe keys ─────────────────────────────

type SourceFile = { path: string; source: string };
type WriterMember = { key: string; kind: WriterKind };

const propertyNameOf = (name: ts.PropertyName): string | null =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;

const enclosingName = (node: ts.Node): string => {
  const names: string[] = [];
  // Ancestors up to the source file, the root of every parsed node.
  for (
    let current = node.parent;
    !ts.isSourceFile(current);
    current = current.parent
  ) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isClassDeclaration(current)) &&
      current.name !== undefined
    ) {
      names.unshift(current.name.getText());
    } else if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name)
    ) {
      names.unshift(current.name.text);
    }
  }
  return names.length === 0 ? "module" : names.join("/");
};

const isNullValue = (node: ts.Expression): boolean =>
  node.kind === ts.SyntaxKind.NullKeyword ||
  (ts.isTaggedTemplateExpression(node) &&
    /^\s*NULL\s*$/iu.test(node.template.getText().slice(1, -1)));

/** Whether an identifier or property in `node` names one of `names`. */
const mentions = (node: ts.Node, names: ReadonlySet<string>): boolean => {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) {
      return;
    }
    if (ts.isIdentifier(child) && names.has(child.text)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
};

const EXTERNAL_ID = new Set(["externalId"]);

const writerMembersOf = ({
  path: file,
  source,
}: SourceFile): WriterMember[] => {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const members: WriterMember[] = [];
  // A second write of the same kind in one function gets its own ordinal key
  // (`#2`, …), so it is a new member rather than a duplicate of a listed one.
  const seen = new Map<string, number>();
  const add = (node: ts.Node, kind: WriterKind, name = enclosingName(node)) => {
    const base = `${file}::${kind}::${name}`;
    const ordinal = (seen.get(base) ?? 0) + 1;
    seen.set(base, ordinal);
    members.push({
      key: ordinal === 1 ? base : `${base}#${ordinal}`,
      kind,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const properties = new Map<string, ts.ObjectLiteralElementLike>();
      for (const property of node.properties) {
        const name =
          property.name === undefined ? null : propertyNameOf(property.name);
        if (name !== null) {
          properties.set(name, property);
        }
      }
      const externalId = properties.get("externalId");
      const writesExternalId =
        properties.has("externalSource") &&
        externalId !== undefined &&
        !(
          ts.isPropertyAssignment(externalId) &&
          isNullValue(externalId.initializer)
        );
      if (
        writesExternalId &&
        ![...CHANGE_MARKERS].some((marker) => properties.has(marker))
      ) {
        add(node, "external-id-write");
      }
      const dedupe = properties.get("dedupeKey");
      if (
        dedupe !== undefined &&
        ts.isPropertyAssignment(dedupe) &&
        mentions(dedupe.initializer, EXTERNAL_ID) &&
        !mentions(dedupe.initializer, CHANGE_MARKERS)
      ) {
        add(dedupe, "external-id-dedupe-key");
      }
    }
    const isDedupeFunctionDeclaration =
      ts.isFunctionDeclaration(node) &&
      node.name?.text.endsWith("DedupeKey") === true;
    const isDedupeFunctionVariable =
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text.endsWith("DedupeKey") &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer));
    const dedupeFunction =
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      (isDedupeFunctionDeclaration || isDedupeFunctionVariable)
        ? node
        : undefined;
    if (
      dedupeFunction !== undefined &&
      mentions(dedupeFunction, EXTERNAL_ID) &&
      !mentions(dedupeFunction, CHANGE_MARKERS)
    ) {
      add(
        dedupeFunction,
        "external-id-dedupe-key",
        dedupeFunction.name?.getText() ?? "module",
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return members;
};

/** A table literal (`pgTable("name", { … })`) with an `external_id` column and no change marker. */
const tableMembersOf = ({ path: file, source }: SourceFile): WriterMember[] => {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const members: WriterMember[] = [];
  const visit = (node: ts.Node): void => {
    const [tableName, columns] = ts.isCallExpression(node)
      ? node.arguments
      : [];
    if (
      tableName !== undefined &&
      columns !== undefined &&
      ts.isStringLiteral(tableName) &&
      ts.isObjectLiteralExpression(columns)
    ) {
      const columnNames = new Set<string>();
      for (const property of columns.properties) {
        if (!ts.isPropertyAssignment(property)) {
          continue;
        }
        const first = ts.isCallExpression(property.initializer)
          ? property.initializer.arguments.at(0)
          : undefined;
        if (first !== undefined && ts.isStringLiteral(first)) {
          columnNames.add(first.text);
        }
      }
      if (
        columnNames.has("external_id") &&
        ![...CHANGE_MARKER_COLUMNS].some((column) => columnNames.has(column))
      ) {
        members.push({
          key: `${file}::external-id-table::${tableName.text}`,
          kind: "external-id-table",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return members;
};

export const scanExternalIdentity = (
  files: readonly SourceFile[],
): WriterMember[] =>
  files
    .flatMap((file) =>
      file.path.startsWith(`${SCHEMA_DIR}/`)
        ? [...tableMembersOf(file), ...writerMembersOf(file)]
        : writerMembersOf(file),
    )
    .toSorted((left, right) => compareCodeUnit(left.key, right.key));

const gitFiles = (pathspecs: readonly string[]): string[] => {
  const listed = Bun.spawnSync(["git", "ls-files", "--", ...pathspecs], {
    cwd: ROOT,
  });
  if (listed.exitCode !== 0) {
    panic(`Cannot enumerate ${pathspecs.join(", ")}`);
  }
  return listed.stdout.toString().trim().split("\n").filter(Boolean);
};

const isProductionSource = (file: string): boolean =>
  file.endsWith(".ts") &&
  !file.endsWith(".test.ts") &&
  !file.endsWith(".d.ts") &&
  !file.includes("/tests/") &&
  !file.includes("/__fixtures__/");

const writerCensus = (): WriterMember[] =>
  scanExternalIdentity(
    gitFiles([`${API_SOURCE_DIR}/*.ts`])
      .filter(isProductionSource)
      .map((file) => ({
        path: file,
        source: readFileSync(path.join(ROOT, file), "utf-8"),
      })),
  );

// ── files: the lint rule in census mode ───────────────────────────────────

const fileCensus = (): string[] => {
  const directory = mkdtempSync(path.join(tmpdir(), "source-fingerprint-"));
  const config = path.join(directory, "oxlint.config.ts");
  const report = path.join(directory, "report.json");
  const files = gitFiles([`${ADAPTERS_DIR}/*.ts`]).filter(isProductionSource);
  for (const file of files) {
    const destination = path.join(directory, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    // A suppression must not hide a member from the census.
    writeFileSync(
      destination,
      readFileSync(path.join(ROOT, file), "utf-8").replaceAll(
        /\b(?:oxlint|eslint)-(?:disable|enable)\b/gu,
        "source-fingerprint-census-directive",
      ),
    );
  }
  writeFileSync(
    config,
    `export default ${JSON.stringify({
      categories: { correctness: "off" },
      jsPlugins: [path.join(ROOT, ".oxlint-plugins", `${RULE}.ts`)],
      rules: { [`${RULE}/${RULE}`]: ["error", { census: true }] },
    })};\n`,
  );
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--bun",
      path.join(ROOT, "node_modules/oxlint/bin/oxlint"),
      "-c",
      config,
      "--format=json",
      ADAPTERS_DIR,
    ],
    { cwd: directory, stdout: Bun.file(report), stderr: "pipe" },
  );
  const output = readFileSync(report, "utf-8");
  rmSync(directory, { recursive: true, force: true });
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    panic(`rawHash census failed: ${result.stderr.toString()}`);
  }
  const diagnostics = v.parse(LINT_OUTPUT, JSON.parse(output)).diagnostics;
  const flagged = new Set<string>();
  for (const { code, filename } of diagnostics) {
    if (!code.startsWith(`${RULE}(`)) {
      panic(`Unexpected rawHash census diagnostic: ${code}`);
    }
    const at = filename.indexOf(`${ADAPTERS_DIR}/`);
    flagged.add(
      at === -1 ? panic(`Census reported ${filename}`) : filename.slice(at),
    );
  }
  return [...flagged].toSorted();
};

// ── drivers: the API guard test's census ──────────────────────────────────

const driverCensus = (): { key: string; reason: string }[] => {
  const directory = mkdtempSync(path.join(tmpdir(), "source-fingerprint-"));
  const out = path.join(directory, "drivers.json");
  const result = Bun.spawnSync(
    [process.execPath, "scripts/run-tests.ts", GUARD_TEST],
    {
      cwd: path.join(ROOT, "apps/api"),
      env: { ...process.env, [CENSUS_OUT_ENV]: out },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const rows =
    result.exitCode === 0 && Bun.file(out).size > 0
      ? v.parse(DRIVER_ROWS, JSON.parse(readFileSync(out, "utf-8")))
      : panic("The source fingerprint guard test failed or wrote no census");
  rmSync(directory, { recursive: true, force: true });
  return rows;
};

// ── comparison ────────────────────────────────────────────────────────────

type SectionDifference = { added: string[]; stale: string[] };

export const sectionDifference = (
  observed: readonly string[],
  recorded: readonly string[],
): SectionDifference => {
  const actual = new Set(observed);
  const expected = new Set(recorded);
  return {
    added: [...actual].filter((key) => !expected.has(key)).toSorted(),
    stale: [...expected].filter((key) => !actual.has(key)).toSorted(),
  };
};

const readBaseline = (): Baseline =>
  parseBaseline(readFileSync(path.join(ROOT, BASELINE), "utf-8"), BASELINE);

const reasoned = (
  rows: readonly { key: string; reason: string }[],
  previous: Readonly<Record<string, string>>,
): Record<string, string> =>
  Object.fromEntries(
    rows
      .toSorted((left, right) => compareCodeUnit(left.key, right.key))
      .map(({ key, reason }) => [key, previous[key] ?? reason]),
  );

const write = (): number => {
  const previous = readBaseline();
  const next: Baseline = {
    comment: previous.comment,
    drivers: reasoned(driverCensus(), previous.drivers),
    files: reasoned(
      fileCensus().map((key) => ({ key, reason: FILE_REASON })),
      previous.files,
    ),
    writers: reasoned(
      writerCensus().map(({ key, kind }) => ({
        key,
        reason: WRITER_REASONS[kind],
      })),
      previous.writers,
    ),
  };
  writeFileSync(
    path.join(ROOT, BASELINE),
    `${JSON.stringify(next, null, 2)}\n`,
  );
  console.log(
    `Source fingerprint baseline written: ${String(Object.keys(next.drivers).length)} drivers, ${String(Object.keys(next.files).length)} files, ${String(Object.keys(next.writers).length)} writers.`,
  );
  return 0;
};

const check = (args: readonly string[]): number => {
  const baseline = readBaseline();
  const failures: string[] = [];
  const observed: Record<Exclude<Section, "drivers">, string[]> = {
    files: fileCensus(),
    writers: writerCensus().map(({ key }) => key),
  };
  for (const section of ["files", "writers"] as const) {
    const { added, stale } = sectionDifference(
      observed[section],
      Object.keys(baseline[section]),
    );
    failures.push(
      ...added.map((key) => `New ${section} member (use the owner): ${key}`),
      ...stale.map(
        (key) =>
          `Migrated ${section} member still listed (run --write): ${key}`,
      ),
    );
  }
  for (const failure of failures) {
    console.error(failure);
  }
  const membership = runLedgerMembershipGuard({
    ledgerRel: BASELINE,
    repoRoot: ROOT,
    parseLedger: (text, label) => ledgerKeys(parseBaseline(text, label)),
    label: "source-fingerprint",
    remediation:
      "derive rawHash with sourceFingerprint and store a change marker instead of listing a new member",
    args,
  });
  if (failures.length > 0 || membership !== 0) {
    return 1;
  }
  console.log(
    `Source fingerprint baseline: ${String(observed.files.length)} files, ${String(observed.writers.length)} writers, exact sets verified.`,
  );
  return 0;
};

const SELF_TEST_SOURCES: readonly SourceFile[] = [
  {
    path: "apps/api/src/lib/example/import.ts",
    source: `
      export const importItems = (items) =>
        items.map((item) => ({ externalSource: "x", externalId: item.id }));
      export const importPair = (left, right) => [
        { externalSource: "x", externalId: left.id },
        { externalSource: "x", externalId: right.id },
      ];
      export const clearIdentity = () => ({ externalSource: null, externalId: null });
      export const syncItems = (items) =>
        items.map((item) => ({ externalSource: "x", externalId: item.id, externalChangeKey: item.etag }));
      export const itemDedupeKey = (workspaceId, externalId) => \`x:\${workspaceId}:\${externalId}\`;
      export const notify = (item) => ({ dedupeKey: \`x:\${item.externalId}\` });
      export const notifyChanged = (item) => ({ dedupeKey: \`x:\${item.externalId}:\${item.contentHash}\` });
    `,
  },
  {
    path: "apps/api/src/db/schema/example.ts",
    source: `
      export const imported = pgTable("imported", { externalId: p.text("external_id") });
      export const synced = pgTable("synced", {
        externalId: p.text("external_id"),
        externalChangeKey: p.text("external_change_key"),
      });
    `,
  },
];

const selfTest = (): number => {
  const failures: string[] = [];
  const keys = scanExternalIdentity(SELF_TEST_SOURCES).map(({ key }) => key);
  const expected = [
    "apps/api/src/db/schema/example.ts::external-id-table::imported",
    "apps/api/src/lib/example/import.ts::external-id-dedupe-key::itemDedupeKey",
    "apps/api/src/lib/example/import.ts::external-id-dedupe-key::notify",
    "apps/api/src/lib/example/import.ts::external-id-write::importItems",
    "apps/api/src/lib/example/import.ts::external-id-write::importPair",
    "apps/api/src/lib/example/import.ts::external-id-write::importPair#2",
  ];
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    failures.push(
      `scan must report exactly ${expected.join(", ")}; got ${keys.join(", ")}`,
    );
  }
  const swapped = addedEntries(
    ledgerKeys({
      comment: "",
      drivers: {},
      files: { "a.ts": "r" },
      writers: {},
    }),
    ledgerKeys({
      comment: "",
      drivers: { "a.ts": "r" },
      files: {},
      writers: {},
    }),
  );
  if (swapped.length !== 1) {
    failures.push("a row moved between sections must count as new");
  }
  for (const failure of failures) {
    console.error(`source-fingerprint --self-test: ${failure}`);
  }
  if (failures.length === 0) {
    console.log("source-fingerprint --self-test: PASS");
  }
  return failures.length === 0 ? 0 : 1;
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    process.exit(selfTest());
  }
  if (args.includes("--write")) {
    process.exit(write());
  }
  process.exit(check(args.filter((arg) => arg !== "--check")));
}
