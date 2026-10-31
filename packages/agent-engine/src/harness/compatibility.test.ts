import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import path from "node:path";
import { Temporal } from "temporal-polyfill/full";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import { isAgentHarness } from "../sandbox";
import {
  bundledHarnessCompatibility,
  HARNESS_COMPATIBILITY_DISPOSITION,
  type HarnessCompatibilityManifest,
  preferNewerManifest,
  resolveHarnessCompatibility,
} from "./compatibility";

const DESKTOP_VERSION = "0.0.1";

/**
 * The managed CLI releases the desktop installs and the desktop's own
 * version. The policy must support and recommend each pinned release, so a
 * pin bump or a policy edit cannot leave the installed CLI refused.
 */
const DESKTOP_DIR = path.join(import.meta.dir, "../../../../apps/desktop");
const MANAGED_RELEASES_PATH = path.join(
  DESKTOP_DIR,
  "src-tauri/harness/releases.gen.json",
);
const DESKTOP_PACKAGE_PATH = path.join(DESKTOP_DIR, "package.json");
const ManagedReleasesSchema = v.object({
  harnesses: v.record(v.string(), v.object({ version: v.string() })),
});

const epochMs = (iso: string) => Temporal.Instant.from(iso).epochMilliseconds;

const stableVersion = fc
  .tuple(fc.nat(3), fc.nat(400), fc.nat(40))
  .map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

const manifestAt = (
  updatedAt: string,
  status: "supported" | "broken" = "supported",
) => ({
  version: 1,
  updatedAt,
  compatibility: [
    {
      harness: "codex",
      desktopRange: ">=0.0.1",
      ranges: [{ range: ">=0.0.0", status }],
    },
  ],
});

const parse = (raw: unknown): HarnessCompatibilityManifest => {
  const floor = bundledHarnessCompatibility();
  const chosen = preferNewerManifest(floor, raw);
  expect(chosen).not.toBe(floor);
  return chosen;
};

describe("bundled harness compatibility", () => {
  test("covers every stable harness version with exactly one range", () => {
    const manifest = bundledHarnessCompatibility();
    expect(manifest.compatibility.length).toBeGreaterThan(0);
    assertProperty(
      "covers every stable harness version with exactly one range",
      fc.property(stableVersion, (version) => {
        for (const policy of manifest.compatibility) {
          const matches = policy.ranges.filter((entry) =>
            Bun.semver.satisfies(version, entry.range),
          );
          expect(matches).toHaveLength(1);
        }
      }),
    );
  });

  test("names only harnesses stella knows and recommends a launchable version", () => {
    for (const policy of bundledHarnessCompatibility().compatibility) {
      const { harness } = policy;
      if (!isAgentHarness(harness)) {
        throw new Error(`Bundled policy names unknown harness ${harness}`);
      }
      expect(policy.recommendedVersion).toBeDefined();
      const resolved = resolveHarnessCompatibility({
        manifest: bundledHarnessCompatibility(),
        harness,
        harnessVersion: policy.recommendedVersion ?? null,
        desktopVersion: DESKTOP_VERSION,
      });
      expect(HARNESS_COMPATIBILITY_DISPOSITION[resolved.status]).toBe("launch");
    }
  });

  test("supports and recommends exactly the release the desktop installs for each harness", async () => {
    const releases = v.parse(
      ManagedReleasesSchema,
      await Bun.file(MANAGED_RELEASES_PATH).json(),
    );
    const desktop = v.parse(
      v.object({ version: v.string() }),
      await Bun.file(DESKTOP_PACKAGE_PATH).json(),
    );
    const pinned = Object.entries(releases.harnesses);
    expect(pinned.length).toBeGreaterThan(0);
    for (const [harness, { version }] of pinned) {
      if (!isAgentHarness(harness)) {
        throw new Error(`The desktop installs unknown harness ${harness}`);
      }
      expect({
        harness,
        ...resolveHarnessCompatibility({
          manifest: bundledHarnessCompatibility(),
          harness,
          harnessVersion: version,
          desktopVersion: desktop.version,
        }),
      }).toMatchObject({
        harness,
        status: "supported",
        recommendedVersion: version,
      });
    }
  });
});

describe("resolving a harness version", () => {
  const manifest = parse({
    version: 1,
    updatedAt: "2026-10-28T00:00:00Z",
    compatibility: [
      {
        harness: "codex",
        desktopRange: ">=0.2.0",
        recommendedVersion: "0.170.0",
        ranges: [
          { range: ">=0.170.0", status: "supported" },
          { range: ">=0.168.0 <0.170.0", status: "graceful" },
          { range: "=0.167.3", status: "broken" },
          { range: "<0.168.0", status: "unsupported" },
        ],
      },
    ],
  });

  const resolve = (harnessVersion: string | null, desktopVersion = "0.2.1") =>
    resolveHarnessCompatibility({
      manifest,
      harness: "codex",
      harnessVersion,
      desktopVersion,
    });

  test("the first matching range decides, so a broken pin overrides a wider range", () => {
    expect(resolve("0.170.4").status).toBe("supported");
    expect(resolve("0.169.0").status).toBe("graceful");
    expect(resolve("0.167.3").status).toBe("broken");
    expect(resolve("0.167.2").status).toBe("unsupported");
    expect(resolve("0.170.4").recommendedVersion).toBe("0.170.0");
  });

  test("a leading v does not change the status", () => {
    assertProperty(
      "a leading v does not change the status",
      fc.property(stableVersion, (version) => {
        expect(resolve(`v${version}`)).toEqual(resolve(version));
      }),
    );
  });

  test("prerelease, missing and malformed versions are unknown and refused", () => {
    assertProperty(
      "prerelease, missing and malformed versions are unknown and refused",
      fc.property(
        fc.oneof(
          stableVersion.map((version) => `${version}-alpha.1`),
          fc
            .string()
            .filter((value) => !/^v?\d+\.\d+\.\d+$/u.test(value.trim())),
          fc.constant(null),
        ),
        (version) => {
          const { status } = resolve(version);
          expect(status).toBe("unknown");
          expect(HARNESS_COMPATIBILITY_DISPOSITION[status]).toBe("refuse");
        },
      ),
    );
  });

  test("a desktop release no policy covers gets unknown for every version", () => {
    expect(resolve("0.170.4", "0.1.9")).toEqual({
      status: "unknown",
      recommendedVersion: null,
      recommendedRange: null,
    });
    expect(
      resolveHarnessCompatibility({
        manifest,
        harness: "claude-code",
        harnessVersion: "2.1.300",
        desktopVersion: "0.2.1",
      }).status,
    ).toBe("unknown");
  });
});

describe("choosing between manifests", () => {
  const isoAt = fc
    .integer({ min: 0, max: 4_000_000_000_000 })
    .map((ms) => Temporal.Instant.fromEpochMilliseconds(ms).toString());

  test("an older or invalid candidate never replaces the manifest in force", () => {
    const candidate = fc.oneof(
      isoAt.map((updatedAt) => ({
        validAt: updatedAt,
        raw: manifestAt(updatedAt),
      })),
      fc.anything().map((raw) => ({ validAt: null, raw })),
      isoAt.map((updatedAt) => ({
        validAt: null,
        raw: { ...manifestAt(updatedAt), version: 2 },
      })),
    );
    assertProperty(
      "an older or invalid candidate never replaces the manifest in force",
      fc.property(fc.array(candidate, { maxLength: 12 }), (candidates) => {
        const floor = bundledHarnessCompatibility();
        let current = floor;
        let newestValid = epochMs(floor.updatedAt);
        for (const { validAt, raw } of candidates) {
          const before = epochMs(current.updatedAt);
          current = preferNewerManifest(current, raw);
          expect(epochMs(current.updatedAt)).toBeGreaterThanOrEqual(before);
          if (validAt !== null) {
            newestValid = Math.max(newestValid, epochMs(validAt));
          }
        }
        expect(epochMs(current.updatedAt)).toBe(newestValid);
      }),
    );
  });

  test("marking the running range broken in a newer manifest refuses launch", () => {
    const floor = bundledHarnessCompatibility();
    const later = Temporal.Instant.from(floor.updatedAt)
      .add({ seconds: 1 })
      .toString();
    const current = preferNewerManifest(floor, manifestAt(later, "broken"));
    const { status } = resolveHarnessCompatibility({
      manifest: current,
      harness: "codex",
      harnessVersion: "0.165.0",
      desktopVersion: DESKTOP_VERSION,
    });
    expect(status).toBe("broken");
    expect(HARNESS_COMPATIBILITY_DISPOSITION[status]).toBe("refuse");
  });
});

describe("manifest validation", () => {
  const base = {
    version: 1,
    updatedAt: "2030-01-01T00:00:00Z",
    compatibility: [
      {
        harness: "codex",
        desktopRange: ">=0.0.1",
        recommendedVersion: "0.170.0",
        ranges: [
          { range: ">=0.170.0", status: "supported" },
          { range: "<0.170.0", status: "unsupported" },
        ],
      },
    ],
  };
  const floor = bundledHarnessCompatibility();
  const accepted = (raw: unknown) => preferNewerManifest(floor, raw) !== floor;

  test("accepts a well-formed manifest and ignores fields it does not know", () => {
    expect(accepted(base)).toBe(true);
    expect(accepted({ ...base, mirrors: ["x"] })).toBe(true);
    expect(
      accepted({
        ...base,
        compatibility: [
          ...base.compatibility,
          {
            harness: "future-harness",
            desktopRange: ">=0.0.1",
            ranges: [{ range: ">=1.0.0", status: "supported" }],
          },
        ],
      }),
    ).toBe(true);
  });

  test("rejects a recommended version outside a supported range", () => {
    const [policy] = base.compatibility;
    expect(
      accepted({
        ...base,
        compatibility: [{ ...policy, recommendedVersion: "0.169.0" }],
      }),
    ).toBe(false);
  });

  test("rejects ranges outside the comparator grammar and unknown statuses", () => {
    const [policy] = base.compatibility;
    for (const range of ["latest", "*", ">= 1.0.0", "1.x", ""]) {
      expect(
        accepted({
          ...base,
          compatibility: [
            { ...policy, ranges: [{ range, status: "supported" }] },
          ],
        }),
      ).toBe(false);
    }
    expect(
      accepted({
        ...base,
        compatibility: [
          { ...policy, ranges: [{ range: ">=0.0.0", status: "maybe" }] },
        ],
      }),
    ).toBe(false);
  });

  test("rejects another format version and a missing timestamp", () => {
    expect(accepted({ ...base, version: 2 })).toBe(false);
    const { updatedAt: _omitted, ...withoutTimestamp } = base;
    expect(accepted(withoutTimestamp)).toBe(false);
  });
});
