#!/usr/bin/env bun

// Census tracked Rust packages without compiling them. The lexical detector
// documents its syntax limits in rust-test-determinism-scan.ts. Ordinary Rust
// module paths inherit cfg(test) across files; #[path] overrides, macro-generated
// modules and indirect accesses to globals are outside this check.
// Run with --write to seed/reduce the census, then run normally to enforce it.

import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { BASELINE_PATHS } from "./baseline-paths.ts";
import {
  parseTestBaseline,
  validateTestBaselineFiles,
} from "./check-test-state-baseline.ts";
import { runLedgerMembershipGuard } from "./ledger-membership.ts";
import { isRecord, matches } from "./oxlint-config-scopes.ts";
import {
  findRustExternalModules,
  type RustTestDeterminismHit,
  scanRustTestDeterminism,
} from "./rust-test-determinism-scan.ts";

export const RUST_TEST_DISCOVERY_INPUTS = {
  sources: "**/*.rs",
  manifests: "**/Cargo.toml",
} as const;

const BASELINE_REL = BASELINE_PATHS.rustTestDeterminism;
const REVIEWED_BOUNDARIES_REL =
  "scripts/rust-test-determinism-reviewed-boundaries.json";
const ROOT = path.resolve(import.meta.dirname, "..");

type ReviewedBoundary = { file: string; line: string; reason: string };

const isReviewedBoundary = (value: unknown): value is ReviewedBoundary => {
  if (
    !isRecord(value) ||
    typeof value["file"] !== "string" ||
    !value["file"].endsWith(".rs") ||
    typeof value["line"] !== "string" ||
    value["line"].trim().length === 0 ||
    typeof value["reason"] !== "string" ||
    value["reason"].trim().length === 0
  ) {
    return false;
  }
  return true;
};

const boundaryId = ({ file, line }: Pick<ReviewedBoundary, "file" | "line">) =>
  `${file}::${line.trim()}`;

export const parseReviewedRustBoundaries = (
  text: string,
  label: string,
): ReviewedBoundary[] => {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every(isReviewedBoundary)) {
    panic(
      `${label} must contain reviewed Rust boundaries with file, line and non-empty reason`,
    );
  }
  return parsed;
};

const moduleDirectory = (file: string, targetRoots: ReadonlySet<string>) => {
  const basename = path.posix.basename(file, ".rs");
  return basename === "mod" || targetRoots.has(file)
    ? path.posix.dirname(file)
    : file.slice(0, -3);
};

export const discoverRustTestFiles = (
  repoRoot: string,
  trackedFiles: readonly string[],
) => {
  const targetRoots = new Set<string>();
  const integrationRoots = new Set<string>();
  const crates = trackedFiles
    .filter((file) => matches(RUST_TEST_DISCOVERY_INPUTS.manifests, file))
    .flatMap((file) => {
      const manifest: unknown = Bun.TOML.parse(
        readFileSync(path.join(repoRoot, file), "utf-8"),
      );
      if (!isRecord(manifest) || !isRecord(manifest["package"])) {
        return [];
      }
      const directory = path.posix.dirname(file);
      for (const kind of ["lib", "bin", "test", "bench", "example"]) {
        const configured = manifest[kind];
        const targets = Array.isArray(configured) ? configured : [configured];
        for (const target of targets) {
          if (!isRecord(target) || typeof target["path"] !== "string") {
            continue;
          }
          const filename = path.posix.join(directory, target["path"]);
          targetRoots.add(filename);
          if (kind === "test") {
            integrationRoots.add(filename);
          }
        }
      }
      return [directory];
    })
    .toSorted((a, b) => b.length - a.length);
  const sources = trackedFiles
    .filter((file) => matches(RUST_TEST_DISCOVERY_INPUTS.sources, file))
    .flatMap((file) => {
      const crate = crates.find(
        (directory) => directory === "." || file.startsWith(`${directory}/`),
      );
      if (crate === undefined) {
        return [];
      }
      const relative = crate === "." ? file : file.slice(crate.length + 1);
      if (
        /^src\/(?:lib|main)\.rs$/u.test(relative) ||
        /^(?:src\/bin|tests|benches|examples)\/[^/]+(?:\.rs|\/main\.rs)$/u.test(
          relative,
        )
      ) {
        targetRoots.add(file);
      }
      return [
        {
          file,
          crate,
          integrationTest:
            integrationRoots.has(file) || relative.split("/").includes("tests"),
        },
      ];
    });
  const byFile = new Map(sources.map((source) => [source.file, source]));
  const modules = new Map(
    sources.map(({ file }) => [
      file,
      findRustExternalModules(
        readFileSync(path.join(repoRoot, file), "utf-8"),
        file,
      ),
    ]),
  );
  // Each source can enter whole-file test scope only once, so cycles terminate.
  const queue = [...sources];
  for (const source of queue) {
    for (const module of modules.get(source.file) ?? []) {
      if (!source.integrationTest && !module.test) {
        continue;
      }
      const prefix = path.posix.join(
        moduleDirectory(source.file, targetRoots),
        module.name,
      );
      for (const filename of [`${prefix}.rs`, `${prefix}/mod.rs`]) {
        const child = byFile.get(filename);
        if (
          child === undefined ||
          child.crate !== source.crate ||
          child.integrationTest
        ) {
          continue;
        }
        child.integrationTest = true;
        queue.push(child);
      }
    }
  }
  return sources.toSorted((a, b) => {
    if (a.file === b.file) {
      return 0;
    }
    return a.file < b.file ? -1 : 1;
  });
};

type EvaluateRustTestBaselineOptions = {
  files: ReadonlyMap<string, readonly RustTestDeterminismHit[]>;
  sources?: ReadonlyMap<string, string>;
  baselineText: string;
  reviewedBoundaryText?: string;
};

type BudgetedRustTestHitsOptions = {
  file: string;
  hits: readonly RustTestDeterminismHit[];
  source: string;
  reviewed: ReadonlySet<string>;
};

const budgetedRustTestHits = ({
  file,
  hits,
  source,
  reviewed,
}: BudgetedRustTestHitsOptions) => {
  const sourceLines = source.split("\n");
  return hits.filter(
    (hit) =>
      !hit.escaped ||
      !reviewed.has(
        boundaryId({
          file,
          line: sourceLines.at(hit.line - 1) ?? "",
        }),
      ),
  );
};

type RustTestBaselineSource = { file: string; crate: string };

type CreateRustTestBaselineOptions = {
  sources: readonly RustTestBaselineSource[];
  files: ReadonlyMap<string, readonly RustTestDeterminismHit[]>;
  sourceText: ReadonlyMap<string, string>;
  reviewedBoundaryText: string;
};

export const createRustTestBaseline = ({
  sources,
  files,
  sourceText,
  reviewedBoundaryText,
}: CreateRustTestBaselineOptions) => {
  const reviewed = new Set(
    parseReviewedRustBoundaries(
      reviewedBoundaryText,
      REVIEWED_BOUNDARIES_REL,
    ).map(boundaryId),
  );
  return Object.fromEntries(
    sources.flatMap(({ file, crate }) => {
      const count = budgetedRustTestHits({
        file,
        hits: files.get(file) ?? [],
        source: sourceText.get(file) ?? "",
        reviewed,
      }).length;
      return count === 0
        ? []
        : [
            [
              file,
              {
                count,
                owner: crate,
                reason: "pre-kit census; inject clocks and isolate test state",
              },
            ],
          ];
    }),
  );
};

export const evaluateRustTestBaseline = ({
  files,
  sources = new Map(),
  baselineText,
  reviewedBoundaryText = "[]",
}: EvaluateRustTestBaselineOptions) => {
  const reviewed = new Set(
    parseReviewedRustBoundaries(
      reviewedBoundaryText,
      REVIEWED_BOUNDARIES_REL,
    ).map(boundaryId),
  );
  const budgets = new Map<string, number>();
  for (const member of parseTestBaseline(baselineText, BASELINE_REL)) {
    const file = member.slice(0, member.lastIndexOf("::"));
    if (!file.endsWith(".rs")) {
      panic(`${BASELINE_REL}: ${file} must be a Rust filename`);
    }
    budgets.set(file, (budgets.get(file) ?? 0) + 1);
  }
  const diagnostics: { file: string; line: number; message: string }[] = [];
  for (const file of new Set([...files.keys(), ...budgets.keys()])) {
    const hits = files.get(file) ?? [];
    const budgetedHits = budgetedRustTestHits({
      file,
      hits,
      source: sources.get(file) ?? "",
      reviewed,
    });
    const budget = budgets.get(file) ?? 0;
    if (budgetedHits.length < budget) {
      diagnostics.push({
        file,
        line: 1,
        message: `Rust test nondeterminism count ${budgetedHits.length} is below baseline ${budget}; shrink ${BASELINE_REL}.`,
      });
    }
    const excess = Math.max(0, budgetedHits.length - budget);
    const unescaped = budgetedHits.filter((hit) => !hit.escaped);
    const escaped = budgetedHits.filter((hit) => hit.escaped);
    const unescapedExcess = Math.min(excess, unescaped.length);
    const escapedExcess = excess - unescapedExcess;
    const excessHits = [
      ...unescaped.slice(unescaped.length - unescapedExcess),
      ...escaped.slice(escaped.length - escapedExcess),
    ];
    for (const hit of excessHits) {
      diagnostics.push({
        file,
        line: hit.line,
        message: hit.escaped
          ? `Rust test ${hit.kind}: Escaped occurrences still need a baseline slot.`
          : `Rust test ${hit.kind}: inject clocks, use channels/barriers, or isolate process-global state; document an intentional boundary with // kit-allow: <reason>.`,
      });
    }
  }
  return diagnostics;
};

if (import.meta.main) {
  const tracked = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: ROOT,
    stderr: "pipe",
  });
  if (tracked.exitCode !== 0) {
    panic(
      `Could not enumerate tracked Rust sources: ${tracked.stderr.toString()}`,
    );
  }
  const trackedFiles = tracked.stdout.toString().split("\0").filter(Boolean);
  const sources = discoverRustTestFiles(ROOT, trackedFiles);
  const sourceText = new Map(
    sources.map(({ file }) => [
      file,
      readFileSync(path.join(ROOT, file), "utf-8"),
    ]),
  );
  const files = new Map(
    sources.map(({ file, integrationTest }) => [
      file,
      scanRustTestDeterminism({
        file,
        source: sourceText.get(file) ?? "",
        integrationTest,
      }),
    ]),
  );
  const reviewedBoundaryText = readFileSync(
    path.join(ROOT, REVIEWED_BOUNDARIES_REL),
    "utf-8",
  );
  if (process.argv.includes("--write")) {
    const baseline = createRustTestBaseline({
      sources,
      files,
      sourceText,
      reviewedBoundaryText,
    });
    writeFileSync(
      path.join(ROOT, BASELINE_REL),
      `${JSON.stringify(baseline, null, 2)}\n`,
    );
    console.log(
      `Rust test census: ${new Set(sources.map(({ crate }) => crate)).size} crates, ${Object.keys(baseline).length} files with nondeterminism.`,
    );
  } else {
    const reviewedBoundaries = parseReviewedRustBoundaries(
      reviewedBoundaryText,
      REVIEWED_BOUNDARIES_REL,
    );
    const baselineMembership = runLedgerMembershipGuard({
      ledgerRel: BASELINE_REL,
      repoRoot: ROOT,
      parseLedger: (text, label) => {
        const members = parseTestBaseline(text, label);
        if (label === BASELINE_REL) {
          validateTestBaselineFiles({
            members,
            repoRoot: ROOT,
            trackedFiles: new Set(trackedFiles),
            baselineRel: BASELINE_REL,
          });
        }
        return members;
      },
      label: "rust-test-determinism",
      remediation:
        "inject clocks and isolate test state instead of adding nondeterminism",
    });
    const reviewedMembership = runLedgerMembershipGuard({
      ledgerRel: REVIEWED_BOUNDARIES_REL,
      repoRoot: ROOT,
      parseLedger: (text, label) =>
        parseReviewedRustBoundaries(text, label).map(boundaryId),
      reviewedEntryAdmission: {
        type: "reasoned",
        entries: reviewedBoundaries.map((entry) => ({
          id: boundaryId(entry),
          reason: entry.reason,
        })),
      },
      label: "rust-test-determinism",
      remediation:
        "inject clocks and isolate test state instead of adding nondeterminism",
    });
    const diagnostics = evaluateRustTestBaseline({
      files,
      sources: sourceText,
      baselineText: readFileSync(path.join(ROOT, BASELINE_REL), "utf-8"),
      reviewedBoundaryText,
    });
    for (const { file, line, message } of diagnostics) {
      console.error(`${file}:${line}: ${message}`);
    }
    if (baselineMembership !== 0 || reviewedMembership !== 0) {
      process.exit(Math.max(baselineMembership, reviewedMembership));
    }
    process.exit(diagnostics.length === 0 ? 0 : 1);
  }
}
