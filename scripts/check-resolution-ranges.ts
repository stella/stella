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
// below the floor of any of them.
//
// Deliberately one-directional (too OLD only): an intentional forward override
// (e.g. forcing a security patch NEWER than a lax range allows) is fine and is
// not flagged; only holding a dependency back below what a dependent requires —
// the failure mode above — is an error. Non-semver specifiers (`workspace:`,
// `catalog:`, `npm:`, git/file) and ranges too complex to reduce to a single
// floor (unions, upper-bounded windows) are skipped: the guard is conservative
// by construction, so it never false-positives on a shape it cannot reason
// about — it only fires on the unambiguous "pinned below a declared floor" case.

import { panic } from "better-result";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJson = async (filePath: string): Promise<Record<string, unknown>> =>
  JSON.parse(await Bun.file(filePath).text());

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

// The minimum version that satisfies a range, for the caret/tilde/gte/exact
// shapes package.json deps overwhelmingly use. Returns null for anything we
// can't safely reduce to one floor (unions `||`, an explicit upper bound `<`,
// wildcards `*`/`x`, or a non-semver specifier), which the caller then skips.
const rangeFloor = (range: string): string | null => {
  const trimmed = range.trim();
  if (trimmed === "" || /[|<*x:]/iu.test(trimmed)) {
    return null;
  }
  const match = /^[\^~>=v\s]*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u.exec(
    trimmed,
  );
  if (match === null) {
    return null;
  }
  const candidate = match[1] ?? "";
  // Guard against a mis-parse: the extracted version must actually satisfy the
  // range it came from before we treat it as that range's floor.
  return Bun.semver.satisfies(candidate, range) ? candidate : null;
};

// A single place — a workspace package.json or a bun.lock package entry — that
// declares a version range for some dependency.
type RangeSource = { range: string; declaredBy: string };

const rangesByPackage = new Map<string, RangeSource[]>();

const addRange = (name: string, range: string, declaredBy: string): void => {
  const existing = rangesByPackage.get(name);
  if (existing) {
    existing.push({ range, declaredBy });
  } else {
    rangesByPackage.set(name, [{ range, declaredBy }]);
  }
};

const collectFromDependencyFields = (
  container: Record<string, unknown>,
  declaredBy: string,
): void => {
  for (const field of DEPENDENCY_FIELDS) {
    const deps = container[field];
    if (!isRecord(deps)) {
      continue;
    }
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range === "string") {
        addRange(name, range, declaredBy);
      }
    }
  }
};

const rootPkg = await readJson(path.join(ROOT, "package.json"));

// bun.lock is JSON-with-trailing-commas ("JSONC"-flavored); a plain JSON.parse
// fails on it. Trailing commas only ever appear directly before a closing
// `}`/`]` and cannot occur inside bun.lock's string values, so stripping them
// is a safe, structure-preserving normalize (same approach as
// scripts/check-lockfile-workspace-versions.ts).
const lockText = await Bun.file(path.join(ROOT, "bun.lock")).text();
const parsedLock: unknown = JSON.parse(lockText.replace(/,(\s*[}\]])/gu, "$1"));
if (!isRecord(parsedLock)) {
  panic("bun.lock did not parse into an object");
}

// Ranges declared by each workspace package (its own package.json fields, as
// mirrored in bun.lock's `workspaces` map — `""` is the repo root).
const lockWorkspaces = parsedLock["workspaces"];
if (isRecord(lockWorkspaces)) {
  for (const [dir, entry] of Object.entries(lockWorkspaces)) {
    if (isRecord(entry)) {
      collectFromDependencyFields(
        entry,
        `workspace ${dir === "" ? "<root>" : dir}`,
      );
    }
  }
}

// Ranges declared by every resolved (transitive) package. Each `packages`
// entry is `[specifier, registry, meta, integrity]`; the range-bearing fields
// live on `meta` (index 2). The key is the dependent's identifier.
const lockPackages = parsedLock["packages"];
if (isRecord(lockPackages)) {
  for (const [key, entry] of Object.entries(lockPackages)) {
    if (Array.isArray(entry) && isRecord(entry[2])) {
      collectFromDependencyFields(entry[2], key);
    }
  }
}

// Intentional below-floor overrides, grandfathered with the reason each is
// safe. A NEW below-floor pin must be fixed (raise the version to satisfy its
// dependents), NOT added here — this list is only for overrides that are
// deliberately, knowingly held below what some dependents declare.
const ALLOWED_BELOW_FLOOR = new Map<string, string>([
  [
    "@emnapi/core",
    "Pinned to 1.9.1 (with @emnapi/runtime) to hold the @stll napi/emnapi " +
      "WASM ABI at one version; some third-party wasm sidecars declare ^1.11 " +
      "but run against 1.9.1 here. See the @stll napi architecture notes.",
  ],
  [
    "@emnapi/runtime",
    "Pinned to 1.9.1 (with @emnapi/core) for the @stll napi/emnapi WASM ABI.",
  ],
]);

type Violation = {
  name: string;
  resolved: string;
  floor: string;
  range: string;
  declaredBy: string;
};

const violations: Violation[] = [];

const checkOverrideMap = (overrides: unknown, kind: string): void => {
  if (!isRecord(overrides)) {
    return;
  }
  for (const [name, resolved] of Object.entries(overrides)) {
    if (ALLOWED_BELOW_FLOOR.has(name)) {
      continue; // grandfathered intentional override (see ALLOWED_BELOW_FLOOR)
    }
    // Only an exact-version override can be compared to a range floor; a range
    // or non-semver specifier (`workspace:`, `catalog:`, `npm:…`) is skipped.
    if (typeof resolved !== "string" || !VERSION_PATTERN.test(resolved)) {
      continue;
    }
    for (const { range, declaredBy } of rangesByPackage.get(name) ?? []) {
      const floor = rangeFloor(range);
      if (floor !== null && Bun.semver.order(resolved, floor) < 0) {
        violations.push({
          name,
          resolved,
          floor,
          range,
          declaredBy: `${declaredBy} (${kind})`,
        });
      }
    }
  }
};

checkOverrideMap(rootPkg["resolutions"], "resolutions");
checkOverrideMap(rootPkg["overrides"], "overrides");

if (violations.length > 0) {
  // Report one line per (package, floor) so a two-layer cascade reads clearly,
  // naming a representative dependent that demands the highest floor.
  const byPackage = new Map<string, Violation>();
  for (const violation of violations) {
    const existing = byPackage.get(violation.name);
    if (!existing || Bun.semver.order(violation.floor, existing.floor) > 0) {
      byPackage.set(violation.name, violation);
    }
  }
  console.error(
    [
      "resolution/override pins a dependency below a dependent's required floor:",
      "",
      ...[...byPackage.values()].map(
        (v) =>
          `  - ${v.name} is pinned to ${v.resolved}, but ${v.declaredBy} requires "${v.range}" (floor ${v.floor}).`,
      ),
      "",
      "A resolution/override silently held this package back below what a",
      "dependent imports from it; that surfaces as a MISSING_EXPORT at build",
      "or runtime, not at install. Raise the pin in the root package.json",
      "resolutions to a version satisfying the range(s) above, then reinstall.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(
  "resolution-range check: no resolution pins a dependency below a dependent's floor. OK.",
);
