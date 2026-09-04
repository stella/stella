#!/usr/bin/env bun
// CI gate: catches a `resolutions` (or `overrides`) entry that pins a package
// BELOW the floor of a range some dependent declares for it.
//
// Why this exists: a root `resolutions` entry force-overrides the version of a
// package everywhere, ignoring the ranges its dependents declare. bun applies
// the override without erroring even when it violates those ranges, so pinning
// a package too OLD is silent at install time — it only surfaces later as a
// `MISSING_EXPORT` (the dependent imports a symbol the older, forced version
// never exported) at build or runtime. This is exactly how a folio bump broke:
// `@stll/folio-react` needed `@stll/folio-core ^0.15.1`, but a stale
// resolution pinned folio-core to `0.12.0`, and `@stll/folio-core ^0.15.1`
// then needed `@stll/docx-core ^0.5.1` while another resolution held docx-core
// at `0.3.0` — a two-layer cascade none of the install/lint gates noticed.
//
// What it checks: for every exact-version resolution `name -> v`, it scans the
// whole dependency graph (every workspace package.json + every package entry
// in bun.lock) for the ranges declared against `name`, and fails if `v` sits
// below the floor of any of them. The graph analysis, the skipped shapes and
// the allowlist live in ./resolution-ranges, shared with the autofix that
// raises an offending pin to its floor.

import path from "node:path";

import {
  analyzeResolutionRanges,
  loadResolutionGraph,
  type ResolutionViolation,
} from "./resolution-ranges";

const ROOT = path.resolve(import.meta.dir, "..");

if (import.meta.main) {
  const violations = analyzeResolutionRanges(await loadResolutionGraph(ROOT));
  if (violations.length > 0) {
    // Report one line per package so a two-layer cascade reads clearly, naming
    // the dependent that demands the highest floor.
    const byPackage = new Map<string, ResolutionViolation>();
    for (const violation of violations) {
      const existing = byPackage.get(violation.packageName);
      if (!existing || Bun.semver.order(violation.floor, existing.floor) > 0) {
        byPackage.set(violation.packageName, violation);
      }
    }
    console.error(
      [
        "resolution/override pins a dependency below a dependent's required floor:",
        "",
        ...[...byPackage.values()].map(
          ({ floor, kind, packageName, pinned, requiredBy: [binding] }) =>
            `  - ${packageName} is pinned to ${pinned}, but ${binding.declaredBy} (${kind}) requires "${binding.range}" (floor ${floor}).`,
        ),
        "",
        "A resolution/override silently held this package back below what a",
        "dependent imports from it; that surfaces as a MISSING_EXPORT at build",
        "or runtime, not at install. Raise the pin in the root package.json",
        "resolutions to a version satisfying the range(s) above, then reinstall:",
        "",
        "    bun scripts/fix-resolution-ranges.ts",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(
    "resolution-range check: no resolution pins a dependency below a dependent's floor. OK.",
  );
}
