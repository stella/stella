// Deployment feature flag guard.
//
// Deployment flags (`FEATURE_*` in the API env schema) are read through one
// owner, `isDeploymentFeatureEnabled` (`apps/api/src/lib/deployment-feature.ts`).
// This guard enumerates what that owner cannot see on its own:
//
//   - every declared flag has at least one reader (an owner call, a `feature`
//     tag on an agent surface, a catalog entry's `feature`, a sanctioned raw
//     read, or a mounted route gate), and every literal read names a declared
//     flag;
//   - no `FEATURE_*` key is read off `process.env`, `Bun.env` or
//     `import.meta.env` anywhere in apps or packages;
//   - over the route table the API serves (`apiRoutes`), a capability whose
//     catalog entry carries a flag is mounted behind a gate on that flag on
//     every mount, every gate stands for a declared flag, and every route is
//     classified: gated, serving a flagged capability, or under a path prefix
//     declared always-on in `ALWAYS_ON_ROUTE_PREFIXES`.
//
// Existing gaps live in `apps/api/deployment-feature-routes-baseline.json`, one
// row per finding with its reason. The baseline only shrinks: a finding missing
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
import { deriveCapabilityId } from "./lib/capability-catalog";
import type {
  Finding,
  MountedRoute,
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
  routeKey,
  scanDeploymentFeatures,
} from "./lib/deployment-feature-scan";
import {
  discoverSafeHandlers,
  isRecord,
  REPO_ROOT,
} from "./lib/enumerate-safe-handlers";

const BASELINE_FILE = "apps/api/deployment-feature-routes-baseline.json";
const CATALOG_DIRECTORY = "packages/cli/capabilities";

/**
 * Path prefixes that serve an always-on surface: no deployment flag may gate
 * them (prefix -> reason). A prefix covers the routes at it and below it.
 * Classifying a surface here is a product decision; until then its routes sit
 * in the baseline as unclassified.
 */
const ALWAYS_ON_ROUTE_PREFIXES: ReadonlyMap<string, string> = new Map([
  [
    "/v1/desktop/matter-candidates",
    "Desktop billing routes enforce authenticated activity and billing feature decisions on every deployment",
  ],
  [
    "/v1/desktop/matters",
    "Desktop billing routes enforce authenticated activity and billing feature decisions on every deployment",
  ],
  [
    "/v1/desktop/time-entries",
    "Desktop billing routes enforce authenticated activity and billing feature decisions on every deployment",
  ],
  [
    "/v1/search-history",
    "Personal search history is available on every deployment",
  ],
  [
    "/v1/me/data-exports",
    "A personal data export is available to every account on every deployment",
  ],
  [
    "/v1/desktop/feature-access",
    "Desktop feature access answers per-caller decisions on every deployment",
  ],
  [
    "/v1/desktop/presence",
    "Desktop account presence supports handoff on every deployment",
  ],
  [
    "/operator",
    "Operator HTTP access is deployment-owned and refuses access when its credential is unset",
  ],
  ["/v1/sanctions", "Public sanctions search is available on every deployment"],
  [
    "/v1/entities/:workspaceId/entity/:entityId/annotations",
    "Highlights and comments on a matter document are available on every deployment",
  ],
  [
    "/v1/entities/:workspaceId/entity/:entityId/field/:fieldId/annotations",
    "Highlights and comments on a matter document are available on every deployment",
  ],
  [
    "/synthetic",
    "Dedicated session creation is deployment-owned and refuses access when its credential is unset",
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

/**
 * The served route table as plain records. A route's capability is the
 * catalog entry whose handler export is the very definition the route mounts.
 * Handler discovery seeds the API env defaults the route modules read at load,
 * so the route table is imported after it.
 */
const loadMountedRoutes = async (
  catalogFeatures: ReadonlyMap<string, string | undefined>,
): Promise<MountedRoute[]> => {
  const discovery = await discoverSafeHandlers();
  if (discovery.importErrors.length > 0) {
    return panic(
      `deployment-feature-guard: handler modules failed to import, so capability mounts cannot be read: ${discovery.importErrors.map(({ id, message }) => `${id}: ${message}`).join("; ")}`,
    );
  }
  const capabilityByDefinition = new Map<object, string>();
  for (const endpoint of discovery.endpoints) {
    const id = deriveCapabilityId({
      file: endpoint.file,
      exportName: endpoint.exportName,
    });
    if (catalogFeatures.has(id)) {
      capabilityByDefinition.set(endpoint.definition, id);
    }
  }
  const { apiRoutes } = await import("../src/api-routes");
  const { deploymentFeatureGateFlag, localDevelopmentGate } =
    await import("../src/lib/deployment-feature-route");
  return apiRoutes.map((entry) => ({
    method: entry.method,
    path: entry.path,
    gateFlags: entry.middleware.flatMap((middleware) => {
      const flag = deploymentFeatureGateFlag(middleware);
      return flag === undefined ? [] : [flag];
    }),
    localDevelopment: entry.middleware.includes(localDevelopmentGate),
    capability: capabilityByDefinition.get(entry.definition),
  }));
};

/** The real tree, as the scanner's input. Each file is read from disk once. */
export const loadRealInput = async (): Promise<ScanInput> => {
  const allFiles = new Set(scanFiles(["apps/api/src/**/*.{ts,tsx}"]));
  const withFlagText = (files: readonly string[]) =>
    files.map(readRecord).filter(({ source }) => source.includes("FEATURE_"));
  const catalogFeatures = readCatalogFeatures();
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
    routes: await loadMountedRoutes(catalogFeatures),
    catalogFeatures,
    alwaysOnRoutePrefixes: ALWAYS_ON_ROUTE_PREFIXES,
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
    case "unclassified-route":
      return BASELINE_REASON;
    case "undeclared-read":
    case "process-env-read":
    case "undeclared-gate-flag":
    case "stale-always-on":
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
const GATED_ROUTE_FLAG = "FEATURE_LEGAL_LISTS";
/** A declared flag that does not gate the lists routes. */
const OTHER_DECLARED_FLAG = "FEATURE_USAGE";
const SELF_TEST_PATH = "/v1/self-test";

const hasKey = (result: ScanResult, key: string): boolean =>
  result.findings.some((finding) => findingKey(finding) === key);

/** Every route gated on `GATED_ROUTE_FLAG`, its gate flags replaced. */
const regateRoutes = (
  input: ScanInput,
  replace: (flags: readonly string[]) => string[],
): ScanInput => ({
  ...input,
  routes: input.routes.map((route) =>
    route.gateFlags.includes(GATED_ROUTE_FLAG)
      ? { ...route, gateFlags: replace(route.gateFlags) }
      : route,
  ),
});

/** Mounted routes serving a capability whose catalog entry carries the gated flag. */
const flaggedMounts = (input: ScanInput): MountedRoute[] =>
  input.routes.filter(
    (route) =>
      route.capability !== undefined &&
      input.catalogFeatures.get(route.capability) === GATED_ROUTE_FLAG,
  );

const reportsEveryFlaggedMount = (
  result: ScanResult,
  real: ScanInput,
): boolean => {
  const expected = flaggedMounts(real);
  return (
    expected.length > 0 &&
    expected.every((route) =>
      hasKey(
        result,
        `flagged-capability:${route.capability ?? ""}@${routeKey(route)}`,
      ),
    )
  );
};

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
    name: "removing a real route's gate is reported on every flagged mount",
    mutate: (input) =>
      regateRoutes(input, (flags) =>
        flags.filter((flag) => flag !== GATED_ROUTE_FLAG),
      ),
    expect: reportsEveryFlaggedMount,
  },
  {
    name: "a gate on another flag does not cover a flagged capability",
    mutate: (input) =>
      regateRoutes(input, (flags) =>
        flags.map((flag) =>
          flag === GATED_ROUTE_FLAG ? OTHER_DECLARED_FLAG : flag,
        ),
      ),
    expect: reportsEveryFlaggedMount,
  },
  {
    name: "a gate on an undeclared flag fails",
    mutate: (input) =>
      regateRoutes(input, (flags) =>
        flags.map((flag) =>
          flag === GATED_ROUTE_FLAG ? SELF_TEST_UNDECLARED : flag,
        ),
      ),
    expect: (result, real) => {
      const gated = real.routes.filter((route) =>
        route.gateFlags.includes(GATED_ROUTE_FLAG),
      );
      return (
        gated.length > 0 &&
        gated.every((route) =>
          hasKey(
            result,
            `undeclared-gate-flag:${SELF_TEST_UNDECLARED}@${routeKey(route)}`,
          ),
        )
      );
    },
  },
  {
    name: "a flagged capability mounted again without its gate fails",
    mutate: (input) => {
      const [mounted] = flaggedMounts(input);
      if (mounted === undefined) {
        return panic(
          `self-test: no capability flagged ${GATED_ROUTE_FLAG} is mounted; update the case`,
        );
      }
      return {
        ...input,
        routes: [
          ...input.routes,
          { ...mounted, path: SELF_TEST_PATH, gateFlags: [] },
        ],
      };
    },
    expect: (result, real) => {
      const [mounted] = flaggedMounts(real);
      return (
        mounted !== undefined &&
        hasKey(
          result,
          `flagged-capability:${mounted.capability ?? ""}@${mounted.method} ${SELF_TEST_PATH}`,
        )
      );
    },
  },
  {
    name: "a new route nobody classified fails",
    mutate: (input) => ({
      ...input,
      routes: [
        ...input.routes,
        {
          method: "GET",
          path: SELF_TEST_PATH,
          gateFlags: [],
          localDevelopment: false,
          capability: undefined,
        },
      ],
    }),
    expect: (result) =>
      hasKey(result, `unclassified-route:GET ${SELF_TEST_PATH}`),
  },
  {
    name: "an always-on prefix no route sits under fails",
    mutate: (input) => ({
      ...input,
      alwaysOnRoutePrefixes: new Map([
        ...input.alwaysOnRoutePrefixes,
        [SELF_TEST_PATH, "self-test"],
      ]),
    }),
    expect: (result) => hasKey(result, `stale-always-on:${SELF_TEST_PATH}`),
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
    clean.routeCount < 200 ||
    clean.gatedRouteCount < 10 ||
    clean.capabilityMountCount < 100
  ) {
    failures.push(
      `the real tree scanned too little (flags ${clean.declared.length}, routes ${clean.routeCount}, gated routes ${clean.gatedRouteCount}, capability mounts ${clean.capabilityMountCount})`,
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
    `routes ${result.routeCount}, gated routes ${result.gatedRouteCount}, capability mounts ${result.capabilityMountCount}`,
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
  const input = await loadRealInput();
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
    "these findings are never baselined; fix them (declare the flag in the env schema and the owner map, read env through the env module, or remove an always-on prefix no route sits under):",
    diff.errors,
  );
  report(
    `new findings; gate the route on its flag, wire or delete the flag, or classify the route's path (ALWAYS_ON_ROUTE_PREFIXES). ${BASELINE_FILE} only shrinks:`,
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
      `deployment-feature-guard: ${result.declared.length} flags, ${result.routeCount} routes, ${result.capabilityMountCount} capability mounts; ${result.findings.length} baselined findings.`,
    );
  }
  return failed ? 1 : 0;
};

if (import.meta.main) {
  process.exit(await main());
}
