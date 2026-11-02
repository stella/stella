import { panic } from "better-result";
import { Temporal } from "temporal-polyfill/full";
import * as v from "valibot";

import type { AgentHarness } from "@stll/api-contract/agent-harness";

import bundledManifestJson from "./harness-compatibility.json" with { type: "json" };

/**
 * Which harness CLI versions a stella desktop release may run. The policy is
 * one file, `harness-compatibility.json`, bundled with each release and
 * refreshed from upstream; marking a range `broken` stops new launches and
 * routing without a release.
 *
 * Format and resolution adapted from t3code (MIT): `providerCompatibility.ts`
 * and the `compatibility` key of its model manifest.
 */

const HARNESS_COMPATIBILITY_STATUSES = [
  "supported",
  "graceful",
  "unsupported",
  "broken",
  "unknown",
] as const;
export type HarnessCompatibilityStatus =
  (typeof HARNESS_COMPATIBILITY_STATUSES)[number];

/**
 * What each status allows. The desktop launches, and the server routes to,
 * only a harness whose status is `launch`; an unrecognised version is refused.
 */
export const HARNESS_COMPATIBILITY_DISPOSITION = {
  supported: "launch",
  graceful: "launch",
  unsupported: "refuse",
  broken: "refuse",
  unknown: "refuse",
} as const satisfies Record<HarnessCompatibilityStatus, "launch" | "refuse">;

const STABLE_VERSION = /^\d+\.\d+\.\d+$/u;
const RANGE_COMPARATOR = /^(?:\^|~|>=|>|<=|<|=)?\d+(?:\.\d+){0,2}$/u;

const StableVersion = v.pipe(v.string(), v.regex(STABLE_VERSION));

/** npm range syntax, restricted to comparators joined by spaces and `||`. */
const VersionRange = v.pipe(
  v.string(),
  v.check(
    (range) =>
      range.split("||").every((group) => {
        const comparators = group.trim().split(/\s+/u);
        return comparators.every((comparator) =>
          RANGE_COMPARATOR.test(comparator),
        );
      }),
    "Expected comparators such as >=1.2.3, joined by spaces or ||.",
  ),
);

const satisfies = (version: string, range: string) =>
  Bun.semver.satisfies(version, range);

const statusFor = (
  ranges: readonly { range: string; status: HarnessCompatibilityStatus }[],
  version: string,
): HarnessCompatibilityStatus =>
  ranges.find((entry) => satisfies(version, entry.range))?.status ?? "unknown";

const HarnessPolicy = v.pipe(
  v.object({
    /** A harness this release does not know is kept but never matches. */
    harness: v.string(),
    desktopRange: VersionRange,
    recommendedVersion: v.optional(StableVersion),
    recommendedRange: v.optional(VersionRange),
    /** First match wins. */
    ranges: v.pipe(
      v.array(
        v.object({
          range: VersionRange,
          status: v.picklist(HARNESS_COMPATIBILITY_STATUSES),
        }),
      ),
      v.minLength(1),
    ),
  }),
  v.check(
    ({ recommendedVersion, recommendedRange, ranges }) =>
      recommendedVersion === undefined ||
      ((recommendedRange === undefined ||
        satisfies(recommendedVersion, recommendedRange)) &&
        statusFor(ranges, recommendedVersion) === "supported"),
    "The recommended version must fall in a supported range.",
  ),
);

const HarnessCompatibilityManifestSchema = v.object({
  version: v.literal(1),
  /** Rollback protection: an older manifest never replaces a newer one. */
  updatedAt: v.pipe(v.string(), v.isoTimestamp()),
  compatibility: v.array(HarnessPolicy),
});

export type HarnessCompatibilityManifest = v.InferOutput<
  typeof HarnessCompatibilityManifestSchema
>;

const updatedAtMs = (manifest: HarnessCompatibilityManifest) =>
  Temporal.Instant.from(manifest.updatedAt).epochMilliseconds;

const bundled: { manifest: HarnessCompatibilityManifest | null } = {
  manifest: null,
};

/** The manifest this release ships with: the floor every candidate must meet. */
export const bundledHarnessCompatibility = (): HarnessCompatibilityManifest => {
  if (bundled.manifest !== null) {
    return bundled.manifest;
  }
  const parsed = v.safeParse(
    HarnessCompatibilityManifestSchema,
    bundledManifestJson,
  );
  if (!parsed.success) {
    return panic(
      `harness-compatibility.json is invalid: ${v.summarize(parsed.issues)}`,
    );
  }
  bundled.manifest = parsed.output;
  return parsed.output;
};

/**
 * Pick between the manifest in force and a candidate from the cache or the
 * network. A candidate that does not parse, or is older than the current
 * one, never wins; an equally new one does, so a refetch replaces a cache.
 */
export const preferNewerManifest = (
  current: HarnessCompatibilityManifest,
  candidate: unknown,
): HarnessCompatibilityManifest => {
  const parsed = v.safeParse(HarnessCompatibilityManifestSchema, candidate);
  if (!parsed.success) {
    return current;
  }
  return updatedAtMs(parsed.output) >= updatedAtMs(current)
    ? parsed.output
    : current;
};

export type HarnessCompatibility = {
  status: HarnessCompatibilityStatus;
  recommendedVersion: string | null;
  recommendedRange: string | null;
};

type ResolveHarnessCompatibilityOptions = {
  manifest: HarnessCompatibilityManifest;
  harness: AgentHarness;
  /** The version the harness reported, or `null` when it reported none. */
  harnessVersion: string | null;
  desktopVersion: string;
};

/**
 * Status of one harness version under the policy for this desktop release.
 * Prerelease and unparseable versions are `unknown`, as is any version when
 * no policy covers the release.
 */
export const resolveHarnessCompatibility = ({
  manifest,
  harness,
  harnessVersion,
  desktopVersion,
}: ResolveHarnessCompatibilityOptions): HarnessCompatibility => {
  const policy = manifest.compatibility.find(
    (entry) =>
      entry.harness === harness &&
      satisfies(desktopVersion, entry.desktopRange),
  );
  if (policy === undefined) {
    return {
      status: "unknown",
      recommendedVersion: null,
      recommendedRange: null,
    };
  }
  const version = harnessVersion?.trim().replace(/^v/u, "") ?? "";
  return {
    status: STABLE_VERSION.test(version)
      ? statusFor(policy.ranges, version)
      : "unknown",
    recommendedVersion: policy.recommendedVersion ?? null,
    recommendedRange: policy.recommendedRange ?? null,
  };
};
