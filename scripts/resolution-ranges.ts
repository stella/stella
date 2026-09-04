// Graph analysis behind the resolution-range guard and its autofix.
//
// A root `resolutions`/`overrides` entry force-overrides a package's version
// everywhere, ignoring the ranges its dependents declare. bun applies the
// override without erroring even when it pins the package BELOW a dependent's
// floor, so the mistake is silent at install and only surfaces later as a
// MISSING_EXPORT at build or runtime. This module reduces the graph to the
// unambiguous "pinned below a declared floor" cases and computes the version
// that repairs each one.
//
// Deliberately one-directional (too OLD only): an intentional forward override
// (forcing a security patch NEWER than a lax range allows) is fine and is not
// flagged. Non-semver specifiers (`workspace:`, `catalog:`, `npm:`, git/file)
// and ranges too complex to reduce to a single floor (unions, upper-bounded
// windows) are skipped, so the guard never false-positives on a shape it
// cannot reason about.
//
// No third-party imports: the autofix workflow runs the CLIs built on this
// module with `bun --no-install` on a checkout that has no node_modules.

import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  applyReplacements,
  directPropertyValue,
  rootObjectStart,
  stringTokenAt,
  type JsonTextReplacement,
} from "./json-text-edit";

const OVERRIDE_KINDS = ["resolutions", "overrides"] as const;

export type OverrideKind = (typeof OVERRIDE_KINDS)[number];

export type Manifest = Readonly<Record<string, unknown>>;

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

const MANIFEST_LABEL = "package.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Intentional below-floor overrides, grandfathered with the reason each is
 * safe. A NEW below-floor pin must be fixed (raise the version to satisfy its
 * dependents), NOT added here — this list is only for overrides that are
 * deliberately, knowingly held below what some dependents declare.
 */
const ALLOWED_BELOW_FLOOR: ReadonlyMap<string, string> = new Map([
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

/**
 * The minimum version that satisfies a range, for the caret/tilde/gte/exact
 * shapes package.json deps overwhelmingly use. Returns null for anything that
 * cannot be safely reduced to one floor (unions `||`, an explicit upper bound
 * `<`, wildcards `*`/`x`, or a non-semver specifier), which callers then skip.
 */
export const rangeFloor = (range: string): string | null => {
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
  // range it came from before it is treated as that range's floor.
  return Bun.semver.satisfies(candidate, range) ? candidate : null;
};

/** A place in the graph that declares dependency ranges. */
export type RangeSource = {
  readonly declaredBy: string;
  readonly manifest: Manifest;
};

/** A single declared range for one package. */
export type RangeDeclaration = {
  readonly declaredBy: string;
  readonly range: string;
};

export type DeclaredRanges = ReadonlyMap<string, readonly RangeDeclaration[]>;

export const collectDeclaredRanges = (
  sources: readonly RangeSource[],
): DeclaredRanges => {
  const ranges = new Map<string, RangeDeclaration[]>();
  for (const { declaredBy, manifest } of sources) {
    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = manifest[field];
      if (!isRecord(dependencies)) {
        continue;
      }
      for (const [name, range] of Object.entries(dependencies)) {
        if (typeof range !== "string") {
          continue;
        }
        const existing = ranges.get(name);
        if (existing) {
          existing.push({ declaredBy, range });
        } else {
          ranges.set(name, [{ declaredBy, range }]);
        }
      }
    }
  }
  return ranges;
};

/**
 * Range declarations carried by a parsed bun.lock: every workspace manifest
 * (`""` is the repo root) plus every resolved transitive package. A `packages`
 * entry is `[specifier, registry, meta, integrity]` and the range-bearing
 * fields live on `meta`.
 */
export const lockRangeSources = (parsedLock: unknown): RangeSource[] => {
  if (!isRecord(parsedLock)) {
    return [];
  }
  const sources: RangeSource[] = [];
  const workspaces = parsedLock["workspaces"];
  if (isRecord(workspaces)) {
    for (const [directory, entry] of Object.entries(workspaces)) {
      if (isRecord(entry)) {
        sources.push({
          declaredBy: `workspace ${directory === "" ? "<root>" : directory}`,
          manifest: entry,
        });
      }
    }
  }
  const packages = parsedLock["packages"];
  if (isRecord(packages)) {
    for (const [key, entry] of Object.entries(packages)) {
      if (Array.isArray(entry) && isRecord(entry[2])) {
        sources.push({ declaredBy: key, manifest: entry[2] });
      }
    }
  }
  return sources;
};

export type ResolutionGraph = {
  readonly declared: DeclaredRanges;
  readonly rootManifest: Manifest;
};

/**
 * The one loading path both the guard and the fixer read: the root manifest's
 * override maps plus every range bun.lock records for the graph.
 *
 * bun.lock is JSON-with-trailing-commas ("JSONC"-flavored), so a plain
 * JSON.parse fails on it. Trailing commas only ever appear directly before a
 * closing `}`/`]` and cannot occur inside bun.lock's string values, so
 * stripping them is a safe, structure-preserving normalize (same approach as
 * scripts/check-lockfile-workspace-versions.ts).
 */
export const loadResolutionGraph = async (
  root: string,
): Promise<ResolutionGraph> => {
  const [manifestText, lockText] = await Promise.all([
    Bun.file(path.join(root, "package.json")).text(),
    Bun.file(path.join(root, "bun.lock")).text(),
  ]);
  const rootManifest: unknown = JSON.parse(manifestText);
  const parsedLock: unknown = JSON.parse(
    lockText.replace(/,(\s*[}\]])/gu, "$1"),
  );
  if (!isRecord(rootManifest)) {
    throw new TypeError("package.json did not parse into an object");
  }
  if (!isRecord(parsedLock)) {
    throw new TypeError("bun.lock did not parse into an object");
  }
  return {
    declared: collectDeclaredRanges(lockRangeSources(parsedLock)),
    rootManifest,
  };
};

/** A declared range whose floor sits above the pinned version. */
export type FloorRequirement = {
  readonly declaredBy: string;
  readonly floor: string;
  readonly range: string;
};

/** A violation always has at least the requirement that set its floor. */
export type FloorRequirements = readonly [
  FloorRequirement,
  ...FloorRequirement[],
];

export type ResolutionViolation = {
  /** Highest floor demanded by any dependent: the version the pin must reach. */
  readonly floor: string;
  readonly kind: OverrideKind;
  readonly packageName: string;
  readonly pinned: string;
  /** Every violated requirement, the one setting `floor` first. */
  readonly requiredBy: FloorRequirements;
};

export type AnalyzeResolutionRangesOptions = {
  readonly allowedBelowFloor?: ReadonlyMap<string, string>;
  readonly declared: DeclaredRanges;
  readonly rootManifest: Manifest;
};

export const analyzeResolutionRanges = ({
  allowedBelowFloor = ALLOWED_BELOW_FLOOR,
  declared,
  rootManifest,
}: AnalyzeResolutionRangesOptions): readonly ResolutionViolation[] => {
  const violations: ResolutionViolation[] = [];
  for (const kind of OVERRIDE_KINDS) {
    const overrides = rootManifest[kind];
    if (!isRecord(overrides)) {
      continue;
    }
    for (const [packageName, pinned] of Object.entries(overrides)) {
      if (allowedBelowFloor.has(packageName)) {
        continue; // grandfathered intentional override
      }
      // Only an exact-version override can be compared to a range floor; a
      // range or non-semver specifier (`workspace:`, `catalog:`, `npm:…`) is
      // skipped.
      if (typeof pinned !== "string" || !VERSION_PATTERN.test(pinned)) {
        continue;
      }
      const requiredBy: FloorRequirement[] = [];
      for (const { declaredBy, range } of declared.get(packageName) ?? []) {
        const floor = rangeFloor(range);
        if (floor !== null && Bun.semver.order(pinned, floor) < 0) {
          requiredBy.push({ declaredBy, floor, range });
        }
      }
      // Highest floor first, first-seen winning a tie, so the representative
      // requirement is both the binding one and stable across runs.
      const [binding, ...rest] = [...requiredBy].sort((left, right) =>
        Bun.semver.order(right.floor, left.floor),
      );
      if (binding === undefined) {
        continue;
      }
      violations.push({
        floor: binding.floor,
        kind,
        packageName,
        pinned,
        requiredBy: [binding, ...rest],
      });
    }
  }
  return violations;
};

export type ResolutionRepair =
  | {
      readonly status: "raise";
      readonly from: string;
      readonly kind: OverrideKind;
      readonly packageName: string;
      readonly requiredBy: FloorRequirements;
      readonly to: string;
    }
  | {
      readonly status: "conflict";
      readonly blockedBy: readonly RangeDeclaration[];
      readonly kind: OverrideKind;
      readonly packageName: string;
      readonly pinned: string;
      readonly target: string;
    };

export type PlanResolutionRepairsOptions = {
  readonly declared: DeclaredRanges;
  readonly violations: readonly ResolutionViolation[];
};

/**
 * Turns violations into pin raises. The target is the highest floor any
 * dependent demands; it is only accepted when it also satisfies every range
 * that constrains the pin today — the violated ranges themselves (an exact
 * `3.1.0` alongside a `^3.2.0` cannot both be met) and every range the current
 * pin already satisfies (raising must not fall out of an upper-bounded window
 * that works today). Otherwise no single version satisfies the dependents and
 * the repair is a conflict a human has to resolve.
 */
export const planResolutionRepairs = ({
  declared,
  violations,
}: PlanResolutionRepairsOptions): readonly ResolutionRepair[] =>
  violations.map((violation) => {
    const { floor, kind, packageName, pinned, requiredBy } = violation;
    const violated = new Set(requiredBy.map(({ range }) => range));
    const blockedBy = (declared.get(packageName) ?? []).filter(
      ({ range }) =>
        (violated.has(range) || Bun.semver.satisfies(pinned, range)) &&
        !Bun.semver.satisfies(floor, range),
    );
    if (blockedBy.length > 0) {
      return {
        status: "conflict",
        blockedBy,
        kind,
        packageName,
        pinned,
        target: floor,
      };
    }
    return {
      status: "raise",
      from: pinned,
      kind,
      packageName,
      requiredBy,
      to: floor,
    };
  });

export type OverridePin = {
  readonly kind: OverrideKind;
  readonly packageName: string;
  readonly version: string;
};

/**
 * Rewrites the pinned versions in a root manifest's override maps, changing
 * nothing else in the file — key order, indentation and trailing bytes survive
 * exactly, which is what lets the autofix boundary check compare texts.
 */
export const applyOverridePins = (
  manifestText: string,
  pins: readonly OverridePin[],
): string => {
  const rootStart = rootObjectStart(manifestText, MANIFEST_LABEL);
  const replacements: JsonTextReplacement[] = pins.map(
    ({ kind, packageName, version }) => {
      const overridesStart = directPropertyValue({
        label: MANIFEST_LABEL,
        missingMessage: `package.json has no ${kind} object`,
        objectStart: rootStart,
        property: kind,
        text: manifestText,
      });
      if (manifestText[overridesStart] !== "{") {
        throw new TypeError(`package.json ${kind} must be an object`);
      }
      const pinStart = directPropertyValue({
        label: MANIFEST_LABEL,
        missingMessage: `package.json ${kind} has no entry for ${packageName}`,
        objectStart: overridesStart,
        property: packageName,
        text: manifestText,
      });
      const token = stringTokenAt(manifestText, pinStart);
      return {
        end: token.end,
        start: token.start,
        value: JSON.stringify(version),
      };
    },
  );
  return applyReplacements(manifestText, replacements);
};

export type ManifestPinChange = {
  readonly from: string;
  readonly kind: OverrideKind;
  readonly packageName: string;
  readonly to: string;
};

export type ManifestChangeVerdict =
  | { readonly status: "unchanged" }
  | {
      readonly status: "pins-raised";
      readonly changes: readonly ManifestPinChange[];
    }
  | { readonly status: "rejected"; readonly reason: string };

const parseManifest = (text: string): Manifest | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
};

type OverrideChanges =
  | { readonly status: "ok"; readonly changes: readonly ManifestPinChange[] }
  | { readonly status: "rejected"; readonly reason: string };

const overrideChanges = (
  kind: OverrideKind,
  before: Manifest,
  after: Manifest,
): OverrideChanges => {
  const beforePins = before[kind];
  const afterPins = after[kind];
  if (!isRecord(beforePins) || !isRecord(afterPins)) {
    return {
      status: "rejected",
      reason: `${kind} must be an object on both sides`,
    };
  }
  const beforeKeys = Object.keys(beforePins);
  if (!isDeepStrictEqual(beforeKeys, Object.keys(afterPins))) {
    return {
      status: "rejected",
      reason: `${kind} keys were added, removed or reordered`,
    };
  }
  const changes: ManifestPinChange[] = [];
  for (const packageName of beforeKeys) {
    const from = beforePins[packageName];
    const to = afterPins[packageName];
    if (from === to) {
      continue;
    }
    if (typeof from !== "string" || typeof to !== "string") {
      return {
        status: "rejected",
        reason: `${kind}.${packageName} is not a version string`,
      };
    }
    if (!VERSION_PATTERN.test(from) || !VERSION_PATTERN.test(to)) {
      return {
        status: "rejected",
        reason: `${kind}.${packageName} is not an exact version`,
      };
    }
    if (Bun.semver.order(to, from) <= 0) {
      return {
        status: "rejected",
        reason: `${kind}.${packageName} was not raised (${from} -> ${to})`,
      };
    }
    changes.push({ from, kind, packageName, to });
  }
  return { status: "ok", changes };
};

/**
 * The autofix boundary: the only manifest edit the workflow may push is an
 * override pin raised to a dependent's floor. Reconstructing `after` by
 * replaying exactly those pin values onto `before` proves that no other byte —
 * key order, formatting, an unrelated field — moved.
 */
export const inspectManifestChange = (
  before: string,
  after: string,
): ManifestChangeVerdict => {
  if (before === after) {
    return { status: "unchanged" };
  }
  const beforeManifest = parseManifest(before);
  const afterManifest = parseManifest(after);
  if (beforeManifest === null || afterManifest === null) {
    return { status: "rejected", reason: "package.json is not a JSON object" };
  }
  const keys = [
    ...new Set([...Object.keys(beforeManifest), ...Object.keys(afterManifest)]),
  ];
  const changedKeys = keys.filter(
    (key) => !isDeepStrictEqual(beforeManifest[key], afterManifest[key]),
  );
  const overrideKinds: readonly string[] = OVERRIDE_KINDS;
  const foreignKeys = changedKeys.filter((key) => !overrideKinds.includes(key));
  if (foreignKeys.length > 0) {
    return {
      status: "rejected",
      reason: `package.json changed outside resolutions: ${foreignKeys.join(", ")}`,
    };
  }

  const changes: ManifestPinChange[] = [];
  for (const kind of OVERRIDE_KINDS) {
    if (!changedKeys.includes(kind)) {
      continue;
    }
    const result = overrideChanges(kind, beforeManifest, afterManifest);
    if (result.status === "rejected") {
      return result;
    }
    changes.push(...result.changes);
  }
  if (changes.length === 0) {
    return {
      status: "rejected",
      reason: "package.json text changed without changing any pin",
    };
  }
  const replayed = applyOverridePins(
    before,
    changes.map(({ kind, packageName, to }) => ({
      kind,
      packageName,
      version: to,
    })),
  );
  if (replayed !== after) {
    return {
      status: "rejected",
      reason: "package.json changed bytes outside the pinned versions",
    };
  }
  return { status: "pins-raised", changes };
};
