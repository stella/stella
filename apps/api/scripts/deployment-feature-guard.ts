// Deployment feature flag guard.
//
// Deployment flags (`FEATURE_*` in the API env schema) are read through one
// owner, `isDeploymentFeatureEnabled` (`apps/api/src/lib/deployment-feature.ts`).
// This guard enumerates what that owner cannot see on its own:
//
//   - every declared flag has at least one reader (an owner call, a `feature`
//     tag on an agent surface, a catalog entry's `feature`, or a sanctioned
//     raw read), and every literal read names a declared flag;
//   - no `FEATURE_*` key is read off `process.env`, `Bun.env` or
//     `import.meta.env` anywhere in apps or packages;
//   - over the real route tree (every handler file that builds an Elysia
//     instance, plus the server root), a capability whose catalog entry carries
//     a flag is mounted behind a gate that reads that flag on every mount,
//     every gate reads declared flags, and every route file is classified: gated, serving a flagged
//     capability, or declared always-on in `ALWAYS_ON_ROUTE_FILES`.
//
// Existing gaps live in `apps/api/deployment-feature-baseline.json`, one row
// per finding with its reason. The baseline only shrinks: a finding missing
// from it fails, a row whose finding is gone fails as stale, and with `--base`
// a row absent from the base revision's baseline fails as growth.
//
// Modes:
//   bun apps/api/scripts/deployment-feature-guard.ts [--base <rev>]   CI gate
//   bun apps/api/scripts/deployment-feature-guard.ts --write-baseline regenerate rows (shrink only)
//   bun apps/api/scripts/deployment-feature-guard.ts --self-test      prove each detector fires on the real tree
//   bun apps/api/scripts/deployment-feature-guard.ts --report         print flags, readers and classifications

import { panic } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { compareCodeUnit } from "@stll/collation";

import { readCapabilityCatalog } from "../../../packages/cli/src/capability-catalog-data";
import type {
  Finding,
  ParseCache,
  ScanInput,
  ScanResult,
  SourceRecord,
} from "./lib/deployment-feature-scan";
import {
  BASELINABLE_KINDS,
  createParseCache,
  DEPLOYMENT_FEATURE_OWNER_FILE,
  findingKey,
  scanDeploymentFeatures,
  SERVER_ROOT_FILE,
} from "./lib/deployment-feature-scan";
import { isRecord, REPO_ROOT } from "./lib/enumerate-safe-handlers";

const BASELINE_FILE = "apps/api/deployment-feature-baseline.json";
const CATALOG_DIRECTORY = "packages/cli/capabilities";

/**
 * Route files that serve an always-on surface: no deployment flag may gate
 * them (file -> reason). Classifying a file here is a product decision; until
 * then it sits in the baseline as unclassified.
 */
const ALWAYS_ON_ROUTE_FILES: ReadonlyMap<string, string> = new Map([
  [
    "apps/api/src/handlers/desktop-feature-access/routes.ts",
    "Desktop feature access answers per-caller decisions on every deployment",
  ],
  [
    "apps/api/src/handlers/desktop-presence/routes.ts",
    "Desktop account presence supports handoff on every deployment",
  ],
  [
    "apps/api/src/handlers/operator/routes.ts",
    "Operator HTTP access is deployment-owned and refuses access when its credential is unset",
  ],
  [
    "apps/api/src/handlers/sanctions/public-routes.ts",
    "Public sanctions search is available on every deployment",
  ],
]);

const TEST_FILE =
  /(?:\.test|\.spec)\.tsx?$|(?:^|\/)(?:__tests__|__fixtures__|tests)\//u;

const scanFiles = (patterns: readonly string[]): string[] => {
  const files = new Set<string>();
  for (const pattern of patterns) {
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: REPO_ROOT })) {
      if (!file.includes("node_modules/") && !TEST_FILE.test(file)) {
        files.add(file);
      }
    }
  }
  return [...files].toSorted();
};

const readRecord = (file: string): SourceRecord => ({
  file,
  source: readFileSync(path.join(REPO_ROOT, file), "utf-8"),
});

const readCatalogFeatures = (): Map<string, string | undefined> => {
  const features = new Map<string, string | undefined>();
  const entries = readCapabilityCatalog(
    pathToFileURL(`${path.join(REPO_ROOT, CATALOG_DIRECTORY)}/`),
  );
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry["id"] !== "string") {
      return panic("deployment-feature-guard: malformed catalog entry");
    }
    const feature = entry["feature"];
    features.set(
      entry["id"],
      typeof feature === "string" ? feature : undefined,
    );
  }
  return features;
};

/** The real tree, as the scanner's input. Each file is read from disk once. */
export const loadRealInput = (): ScanInput => {
  const sources = new Map<string, string | undefined>();
  const allFiles = new Set(scanFiles(["apps/api/src/**/*.{ts,tsx}"]));
  const routeFiles = scanFiles(["apps/api/src/handlers/**/*.ts"])
    .map(readRecord)
    .filter(({ source }) => /\bnew Elysia\s*\(/u.test(source));
  routeFiles.push(readRecord(SERVER_ROOT_FILE));
  const withFlagText = (files: readonly string[]) =>
    files.map(readRecord).filter(({ source }) => source.includes("FEATURE_"));
  return {
    ownerSource: readRecord(DEPLOYMENT_FEATURE_OWNER_FILE).source,
    readerFiles: withFlagText([...allFiles]),
    processEnvFiles: withFlagText(
      scanFiles([
        "apps/*/src/**/*.{ts,tsx}",
        "apps/*/scripts/**/*.ts",
        "packages/*/src/**/*.{ts,tsx}",
        "packages/*/scripts/**/*.ts",
      ]).filter((file) => !allFiles.has(file)),
    ),
    routeFiles,
    catalogFeatures: readCatalogFeatures(),
    alwaysOnRouteFiles: ALWAYS_ON_ROUTE_FILES,
    allFiles,
    readSource: (file) => {
      if (sources.has(file)) {
        return sources.get(file);
      }
      const absolute = path.join(REPO_ROOT, file);
      const source = existsSync(absolute)
        ? readFileSync(absolute, "utf-8")
        : undefined;
      sources.set(file, source);
      return source;
    },
  };
};

// --- Baseline -------------------------------------------------------------------

type BaselineRow = { key: string; reason: string };

/** The one reason every generated baseline row carries. */
export const BASELINE_REASON = "pending gate classification";

const reasonFor = (finding: Finding): string => {
  switch (finding.kind) {
    case "dead-flag":
    case "flagged-capability":
    case "route-file":
      return BASELINE_REASON;
    case "undeclared-read":
    case "process-env-read":
    case "undeclared-gate-flag":
    case "unattributed-mount":
      return panic(
        `deployment-feature-guard: ${finding.kind} findings are never baselined`,
      );
    default:
      finding satisfies never;
      return panic("deployment-feature-guard: unknown finding kind");
  }
};

export const buildBaseline = (findings: readonly Finding[]): BaselineRow[] =>
  findings
    .filter((finding) => BASELINABLE_KINDS.has(finding.kind))
    .map((finding) => ({
      key: findingKey(finding),
      reason: reasonFor(finding),
    }))
    .toSorted((a, b) => compareCodeUnit(a.key, b.key));

const parseBaseline = (raw: unknown, origin: string): BaselineRow[] => {
  if (!Array.isArray(raw)) {
    return panic(`deployment-feature-guard: ${origin} must be a JSON array`);
  }
  return raw.map((row: unknown) => {
    if (
      !isRecord(row) ||
      typeof row["key"] !== "string" ||
      row["reason"] !== BASELINE_REASON
    ) {
      return panic(
        `deployment-feature-guard: ${origin} rows are { key, reason } with reason "${BASELINE_REASON}"`,
      );
    }
    return { key: row["key"], reason: row["reason"] };
  });
};

const readBaseline = (): BaselineRow[] => {
  const absolute = path.join(REPO_ROOT, BASELINE_FILE);
  return existsSync(absolute)
    ? parseBaseline(JSON.parse(readFileSync(absolute, "utf-8")), BASELINE_FILE)
    : [];
};

const gitSucceeds = (args: readonly string[]): boolean =>
  Bun.spawnSync(["git", ...args], { cwd: REPO_ROOT, stderr: "ignore" })
    .exitCode === 0;

/**
 * The base revision's baseline; undefined only when the revision exists and
 * has no baseline file. A revision that does not resolve fails.
 */
export const readBaseBaseline = (base: string): BaselineRow[] | undefined => {
  if (!gitSucceeds(["cat-file", "-e", `${base}^{commit}`])) {
    return panic(`deployment-feature-guard: --base ${base} is not a commit`);
  }
  if (!gitSucceeds(["cat-file", "-e", `${base}:${BASELINE_FILE}`])) {
    return undefined;
  }
  const result = Bun.spawnSync(["git", "show", `${base}:${BASELINE_FILE}`], {
    cwd: REPO_ROOT,
  });
  if (result.exitCode !== 0) {
    return panic(
      `deployment-feature-guard: cannot read ${base}:${BASELINE_FILE}`,
    );
  }
  return parseBaseline(
    JSON.parse(result.stdout.toString()),
    `${base}:${BASELINE_FILE}`,
  );
};

type BaselineDiff = {
  /** Findings that may never be baselined. */
  errors: string[];
  /** Baselinable findings missing from the baseline. */
  unbaselined: string[];
  /** Baseline rows whose finding is gone. */
  stale: string[];
  /** Rows absent from the base revision's baseline. */
  grown: string[];
  /** Rows out of key order or duplicated. */
  malformed: boolean;
};

export const diffBaseline = ({
  findings,
  baseline,
  baseBaseline,
}: {
  findings: readonly Finding[];
  baseline: readonly BaselineRow[];
  baseBaseline: readonly BaselineRow[] | undefined;
}): BaselineDiff => {
  const keys = new Set(baseline.map(({ key }) => key));
  const current = new Set(findings.map(findingKey));
  const sorted = baseline.map(({ key }) => key).toSorted(compareCodeUnit);
  const baseKeys =
    baseBaseline === undefined
      ? undefined
      : new Set(baseBaseline.map(({ key }) => key));
  return {
    errors: findings
      .filter((finding) => !BASELINABLE_KINDS.has(finding.kind))
      .map(findingKey),
    unbaselined: findings
      .filter((finding) => BASELINABLE_KINDS.has(finding.kind))
      .map(findingKey)
      .filter((key) => !keys.has(key)),
    stale: [...keys].filter((key) => !current.has(key)).toSorted(),
    grown:
      baseKeys === undefined
        ? []
        : [...keys].filter((key) => !baseKeys.has(key)).toSorted(),
    malformed:
      keys.size !== baseline.length ||
      baseline.some(({ key }, index) => key !== sorted[index]),
  };
};

// --- Self-test --------------------------------------------------------------------

type SelfTestCase = {
  name: string;
  mutate: (input: ScanInput) => ScanInput;
  /** `real` is the unmutated input the case was applied to. */
  expect: (result: ScanResult, real: ScanInput) => boolean;
};

const SELF_TEST_UNDECLARED = "FEATURE_SELF_TEST_UNDECLARED";
const SELF_TEST_DEAD = "FEATURE_SELF_TEST_DEAD";
const GATED_ROUTE_FILE = "apps/api/src/handlers/lists/routes.ts";
const GATED_ROUTE_FLAG = "FEATURE_LEGAL_LISTS";
const SELF_TEST_ROUTE_FILE = "apps/api/src/handlers/self-test/routes.ts";

const hasKey = (result: ScanResult, key: string): boolean =>
  result.findings.some((finding) => findingKey(finding) === key);

const replaceRouteSource = (
  input: ScanInput,
  file: string,
  replace: (source: string) => string,
): ScanInput => ({
  ...input,
  routeFiles: input.routeFiles.map((record) =>
    record.file === file ? { file, source: replace(record.source) } : record,
  ),
});

const flaggedCapabilitiesIn = (input: ScanInput, domain: string): string[] =>
  [...input.catalogFeatures]
    .filter(([id, flag]) => id.startsWith(`${domain}.`) && flag !== undefined)
    .map(([id]) => id);

export const SELF_TEST_CASES: readonly SelfTestCase[] = [
  {
    name: "a read of an undeclared flag fails",
    mutate: (input) => ({
      ...input,
      readerFiles: [
        ...input.readerFiles,
        {
          file: "apps/api/src/self-test/undeclared.ts",
          source: `export const on = isDeploymentFeatureEnabled("${SELF_TEST_UNDECLARED}");`,
        },
      ],
    }),
    expect: (result) =>
      hasKey(
        result,
        `undeclared-read:${SELF_TEST_UNDECLARED}:apps/api/src/self-test/undeclared.ts`,
      ),
  },
  {
    name: "a declared flag nothing reads is dead",
    mutate: (input) => ({
      ...input,
      ownerSource: input.ownerSource.replace(
        "const LOCAL_DEV_ACCESS_BY_FLAG = {",
        () =>
          `const LOCAL_DEV_ACCESS_BY_FLAG = {\n  ${SELF_TEST_DEAD}: LOCAL_DEV_ACCESS.open,`,
      ),
    }),
    expect: (result) => hasKey(result, `dead-flag:${SELF_TEST_DEAD}`),
  },
  {
    name: "a raw process-env flag read fails",
    mutate: (input) => ({
      ...input,
      processEnvFiles: [
        ...input.processEnvFiles,
        {
          file: "packages/self-test/src/raw.ts",
          source: `export const a = process.env.${GATED_ROUTE_FLAG};\nexport const b = Bun.env["FEATURE_USAGE"];\nexport const c = import.meta.env.FEATURE_USAGE;`,
        },
      ],
    }),
    expect: (result) =>
      hasKey(
        result,
        `process-env-read:${GATED_ROUTE_FLAG}:packages/self-test/src/raw.ts`,
      ) &&
      hasKey(
        result,
        "process-env-read:FEATURE_USAGE:packages/self-test/src/raw.ts",
      ),
  },
  {
    name: "removing a real route's flag check is reported",
    mutate: (input) =>
      replaceRouteSource(input, GATED_ROUTE_FILE, (source) =>
        source.replace(
          `isDeploymentFeatureEnabled("${GATED_ROUTE_FLAG}")`,
          () => "true",
        ),
      ),
    expect: (result, real) => {
      const expected = flaggedCapabilitiesIn(real, "lists");
      return (
        expected.length > 0 &&
        expected.every((id) =>
          result.findings.some(
            (finding) =>
              finding.kind === "flagged-capability" &&
              finding.capability === id,
          ),
        )
      );
    },
  },
  {
    name: "a gate added after the routes does not cover them",
    mutate: (input) =>
      replaceRouteSource(input, GATED_ROUTE_FILE, (source) => {
        const gate = `  .use(\n    deploymentFeatureGate(() =>\n      isDeploymentFeatureEnabled("${GATED_ROUTE_FLAG}"),\n    ),\n  )\n`;
        if (!source.includes(gate)) {
          return panic(
            "self-test: the lists route gate moved; update the case",
          );
        }
        return source
          .replace(gate, () => "")
          .replace(/;\s*$/u, () => `\n${gate};\n`);
      }),
    expect: (result) =>
      result.findings.some(
        (finding) =>
          finding.kind === "flagged-capability" &&
          finding.routeFile === GATED_ROUTE_FILE,
      ),
  },
  {
    name: "a gate reading an undeclared flag fails",
    mutate: (input) =>
      replaceRouteSource(input, GATED_ROUTE_FILE, (source) =>
        source.replace(
          `isDeploymentFeatureEnabled("${GATED_ROUTE_FLAG}")`,
          () => `isDeploymentFeatureEnabled("${SELF_TEST_UNDECLARED}")`,
        ),
      ),
    expect: (result) =>
      hasKey(
        result,
        `undeclared-gate-flag:${SELF_TEST_UNDECLARED}:${GATED_ROUTE_FILE}`,
      ),
  },
  {
    name: "a new route file nobody classified fails",
    mutate: (input) => ({
      ...input,
      routeFiles: [
        ...input.routeFiles,
        {
          file: SELF_TEST_ROUTE_FILE,
          source: `import Elysia from "elysia";\nexport const selfTestRoute = new Elysia().get("/", () => "ok");\n`,
        },
      ],
    }),
    expect: (result) => hasKey(result, `route-file:${SELF_TEST_ROUTE_FILE}`),
  },
  {
    name: "a mount outside any walked chain fails",
    mutate: (input) => ({
      ...input,
      routeFiles: [
        ...input.routeFiles,
        {
          file: SELF_TEST_ROUTE_FILE,
          source: `import Elysia from "elysia";\nimport readLists from "@/api/handlers/lists/list";\nexport const selfTestRoute = new Elysia();\nexport const mount = (app: typeof selfTestRoute) => app.get("/", readLists.handler);\n`,
        },
      ],
    }),
    expect: (result) =>
      hasKey(
        result,
        `unattributed-mount:readLists.handler@${SELF_TEST_ROUTE_FILE}`,
      ),
  },
];

/**
 * Names of self-test cases whose detector did not fire. Every case edits a
 * copy of `input` in memory, and all scans share `cache`, so only the files a
 * case edits parse again.
 */
export const runSelfTest = (input: ScanInput, cache: ParseCache): string[] => {
  const failures: string[] = [];
  const clean = scanDeploymentFeatures(input, cache);
  if (
    clean.declared.length === 0 ||
    clean.routeFileCount < 50 ||
    clean.instanceCount < 50 ||
    clean.capabilityMountCount < 100
  ) {
    failures.push(
      `the real tree scanned too little (flags ${clean.declared.length}, route files ${clean.routeFileCount}, instances ${clean.instanceCount}, capability mounts ${clean.capabilityMountCount})`,
    );
  }
  for (const testCase of SELF_TEST_CASES) {
    const result = scanDeploymentFeatures(testCase.mutate(input), cache);
    if (!testCase.expect(result, input)) {
      failures.push(testCase.name);
    }
  }
  return failures;
};

// --- CLI ------------------------------------------------------------------------------

const printReport = (result: ScanResult): void => {
  const readers = new Map<string, Map<string, number>>();
  for (const read of result.reads) {
    const forms = readers.get(read.flag) ?? new Map<string, number>();
    forms.set(read.form, (forms.get(read.form) ?? 0) + 1);
    readers.set(read.flag, forms);
  }
  console.log(`declared flags: ${result.declared.length}`);
  for (const flag of result.declared) {
    const forms = readers.get(flag);
    const summary =
      forms === undefined
        ? "NO READER"
        : [...forms].map(([form, count]) => `${form} ${count}`).join(", ");
    console.log(`  ${flag}: ${summary}`);
  }
  console.log(
    `route files ${result.routeFileCount}, instances ${result.instanceCount}, capability mounts ${result.capabilityMountCount}`,
  );
  const byKind = new Map<string, number>();
  for (const finding of result.findings) {
    byKind.set(finding.kind, (byKind.get(finding.kind) ?? 0) + 1);
  }
  for (const [kind, count] of byKind) {
    console.log(`  ${kind}: ${count}`);
  }
  for (const finding of result.findings) {
    console.log(`    ${findingKey(finding)}`);
  }
};

/** `--base <rev>`; a present flag with an empty or missing value fails. */
const baseArgument = (): string | undefined => {
  const index = process.argv.indexOf("--base");
  if (index === -1) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("-")) {
    return panic("deployment-feature-guard: --base needs a revision");
  }
  return value;
};

const main = async (): Promise<number> => {
  // Parsed first so a bad `--base` fails before the scan.
  const base = baseArgument();
  const input = loadRealInput();
  if (process.argv.includes("--self-test")) {
    const failures = runSelfTest(input, createParseCache());
    for (const failure of failures) {
      console.error(
        `deployment-feature-guard self-test: did not fire: ${failure}`,
      );
    }
    if (failures.length === 0) {
      console.log(
        `deployment-feature-guard self-test: ${SELF_TEST_CASES.length} detectors fire on the real tree.`,
      );
    }
    return failures.length === 0 ? 0 : 1;
  }
  const result = scanDeploymentFeatures(input, createParseCache());
  if (process.argv.includes("--report")) {
    printReport(result);
    return 0;
  }
  if (process.argv.includes("--write-baseline")) {
    const rows = buildBaseline(result.findings);
    await Bun.write(
      path.join(REPO_ROOT, BASELINE_FILE),
      `${JSON.stringify(rows, null, 2)}\n`,
    );
    console.log(`deployment-feature-guard: wrote ${rows.length} rows.`);
    return 0;
  }
  const baseBaseline = base === undefined ? undefined : readBaseBaseline(base);
  const diff = diffBaseline({
    findings: result.findings,
    baseline: readBaseline(),
    baseBaseline,
  });
  const report = (title: string, keys: readonly string[]) => {
    if (keys.length > 0) {
      console.error(`\ndeployment-feature-guard: ${title}`);
      for (const key of keys) {
        console.error(`  ${key}`);
      }
    }
  };
  report(
    "these findings are never baselined; fix them (declare the flag in the env schema and the owner map, read env through the env module, or mount the route inside a walked Elysia chain):",
    diff.errors,
  );
  report(
    `new findings; gate the route on its flag, wire or delete the flag, or classify the route file (ALWAYS_ON_ROUTE_FILES). ${BASELINE_FILE} only shrinks:`,
    diff.unbaselined,
  );
  report(
    `stale rows; the finding is fixed, delete the row from ${BASELINE_FILE}:`,
    diff.stale,
  );
  report(
    `rows added since ${base ?? "base"}; the baseline only shrinks:`,
    diff.grown,
  );
  if (diff.malformed) {
    console.error(
      `\ndeployment-feature-guard: ${BASELINE_FILE} must be sorted by key without duplicates (--write-baseline).`,
    );
  }
  const failed =
    diff.errors.length +
      diff.unbaselined.length +
      diff.stale.length +
      diff.grown.length >
      0 || diff.malformed;
  if (!failed) {
    console.log(
      `deployment-feature-guard: ${result.declared.length} flags, ${result.routeFileCount} route files, ${result.capabilityMountCount} capability mounts; ${result.findings.length} baselined findings.`,
    );
  }
  return failed ? 1 : 0;
};

if (import.meta.main) {
  process.exit(await main());
}
