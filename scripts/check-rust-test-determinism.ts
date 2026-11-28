#!/usr/bin/env bun

// Census tracked Rust packages without compiling them. The lexical detector
// documents its syntax limits in rust-test-determinism-scan.ts. Ordinary Rust
// module paths inherit cfg(test) across files; #[path] overrides, macro-generated
// modules and indirect accesses to globals are outside this check.

import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";

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
  const idOf = (hit: RustTestDeterminismHit) =>
    boundaryId({ file, line: sourceLines.at(hit.line - 1) ?? "" });
  // A reviewed boundary covers the one line it names. A copy of that line,
  // escaped or not, is a new occurrence, so a boundary repeated in its file
  // reviews no copy: the copies share one helper instead, reviewed once.
  const reviewedLines = new Map<string, Set<number>>();
  for (const hit of hits) {
    const id = idOf(hit);
    if (reviewed.has(id)) {
      reviewedLines.set(id, (reviewedLines.get(id) ?? new Set()).add(hit.line));
    }
  }
  return hits
    .filter((hit) => !hit.escaped || reviewedLines.get(idOf(hit))?.size !== 1)
    .map((hit) => ({
      ...hit,
      repeatedBoundary: (reviewedLines.get(idOf(hit))?.size ?? 0) > 1,
    }));
};

const excessMessage = ({
  kind,
  escaped,
  repeatedBoundary,
}: RustTestDeterminismHit & { repeatedBoundary: boolean }) => {
  if (repeatedBoundary) {
    return `Rust test ${kind}: this reviewed boundary is repeated in its file; a reviewed boundary covers one line, so move the copies into one helper.`;
  }
  if (escaped) {
    return `Rust test ${kind}: Escaped occurrences must be listed in ${REVIEWED_BOUNDARIES_REL}.`;
  }
  return `Rust test ${kind}: inject clocks, use channels/barriers, or isolate process-global state; document an intentional boundary with // kit-allow: <reason>.`;
};

export const evaluateRustTestBaseline = ({
  files,
  sources = new Map(),
  reviewedBoundaryText = "[]",
}: EvaluateRustTestBaselineOptions) => {
  const reviewed = new Set(
    parseReviewedRustBoundaries(
      reviewedBoundaryText,
      REVIEWED_BOUNDARIES_REL,
    ).map(boundaryId),
  );
  const diagnostics: { file: string; line: number; message: string }[] = [];
  for (const [file, hits] of files) {
    const unreviewedHits = budgetedRustTestHits({
      file,
      hits,
      source: sources.get(file) ?? "",
      reviewed,
    });
    for (const hit of unreviewedHits) {
      diagnostics.push({
        file,
        line: hit.line,
        message: excessMessage(hit),
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
  const reviewedBoundaries = parseReviewedRustBoundaries(
    reviewedBoundaryText,
    REVIEWED_BOUNDARIES_REL,
  );
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
    reviewedBoundaryText,
  });
  for (const { file, line, message } of diagnostics) {
    console.error(`${file}:${line}: ${message}`);
  }
  if (reviewedMembership !== 0) {
    process.exit(reviewedMembership);
  }
  process.exit(diagnostics.length === 0 ? 0 : 1);
}
