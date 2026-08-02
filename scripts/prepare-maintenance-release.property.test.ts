import { afterEach, describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { propertyConfig } from "@stll/property-testing";

import {
  nextPatchVersion,
  parseMaintenanceReleaseOptions,
  parseStableVersion,
  prepareMaintenanceReleaseFiles,
} from "./prepare-maintenance-release";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("maintenance release preparation", () => {
  test("increments every safe stable patch version without changing its series", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 1_000_000 }),
        fc.nat({ max: 1_000_000 }),
        fc.nat({ max: 1_000_000 }),
        (major, minor, patch) => {
          const next = nextPatchVersion(
            parseStableVersion(`${major}.${minor}.${patch}`),
          );
          expect(next).toEqual({
            major,
            minor,
            patch: patch + 1,
            value: `${major}.${minor}.${patch + 1}`,
          });
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("makes recording attestation an explicit reviewed state", () => {
    expect(parseMaintenanceReleaseOptions([])).toEqual({
      recordingReviewReason: null,
    });
    expect(() =>
      parseMaintenanceReleaseOptions([
        "--reason",
        "Current recordings remain representative.",
      ]),
    ).toThrow("requires --confirm-current-recordings-reviewed");
    expect(
      parseMaintenanceReleaseOptions([
        "--confirm-current-recordings-reviewed",
        "--reason",
        "Current recordings remain representative.",
      ]),
    ).toEqual({
      recordingReviewReason: "Current recordings remain representative.",
    });
  });

  test("writes the complete release file set", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(root);
    mkdirSync(nodePath.join(root, "docs/changelog"), { recursive: true });
    mkdirSync(nodePath.join(root, "apps/landing/src/data"), {
      recursive: true,
    });
    writeFileSync(nodePath.join(root, "VERSION"), "1.2.3\n");
    writeFileSync(
      nodePath.join(root, "docs/changelog/v1.2.3.md"),
      "# Previous release\n",
    );
    writeFileSync(
      nodePath.join(root, "apps/landing/src/data/changelog-release-dates.json"),
      `${JSON.stringify({ _note: "fixture", "v1.2.2": "2026-01-01T00:00:00Z" }, null, 2)}\n`,
    );

    expect(
      prepareMaintenanceReleaseFiles({
        publishedAt: "2026-02-03T04:05:06Z",
        rootDir: root,
      }),
    ).toEqual({
      changelogPath: "docs/changelog/v1.2.4.md",
      previousTag: "v1.2.3",
      version: "1.2.4",
    });
    expect(readFileSync(nodePath.join(root, "VERSION"), "utf-8")).toBe(
      "1.2.4\n",
    );
    expect(
      readFileSync(nodePath.join(root, "docs/changelog/v1.2.4.md"), "utf-8"),
    ).toBe(
      "# Maintenance release\n\nStella includes reliability and maintenance improvements.\n",
    );
    const releaseDates: unknown = JSON.parse(
      readFileSync(
        nodePath.join(
          root,
          "apps/landing/src/data/changelog-release-dates.json",
        ),
        "utf-8",
      ),
    );
    expect(releaseDates).toEqual({
      _note: "fixture",
      "v1.2.2": "2026-01-01T00:00:00Z",
      "v1.2.3": "2026-02-03T04:05:06Z",
    });
  });

  test("refuses to overwrite an already prepared release", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(root);
    mkdirSync(nodePath.join(root, "docs/changelog"), { recursive: true });
    mkdirSync(nodePath.join(root, "apps/landing/src/data"), {
      recursive: true,
    });
    writeFileSync(nodePath.join(root, "VERSION"), "1.2.3\n");
    writeFileSync(
      nodePath.join(root, "docs/changelog/v1.2.3.md"),
      "# Previous release\n",
    );
    writeFileSync(
      nodePath.join(root, "docs/changelog/v1.2.4.md"),
      "# Existing release\n",
    );
    writeFileSync(
      nodePath.join(root, "apps/landing/src/data/changelog-release-dates.json"),
      "{}\n",
    );

    expect(() =>
      prepareMaintenanceReleaseFiles({
        publishedAt: "2026-02-03T04:05:06Z",
        rootDir: root,
      }),
    ).toThrow("already exists");
  });
});
