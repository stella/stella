import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DESKTOP_SUPPORT_FLOOR_PATH,
  moveDesktopSupportFloor,
  readDesktopRebuildPaths,
  readDesktopSupportFloor,
  resolveDesktopSupportFloor,
} from "./check-desktop-support-floor";
import { MAINTENANCE_CUT_GATES } from "./prepare-maintenance-release-gates";
import { parseReleaseManifest } from "./promoted-release-policy";

const ROOT = path.resolve(import.meta.dirname, "..");

const SUPPORT_DAYS = 30;

// v1.0.2 was built but never promoted, so it published no desktop build.
const RELEASES = {
  "v1.0.0": "2026-01-01T00:00:00Z",
  "v1.0.1": "2026-01-10T00:00:00Z",
  "v1.0.2": null,
  "v1.0.3": "2026-01-20T00:00:00Z",
  "v1.0.4": "2026-02-15T00:00:00Z",
};
const PROMOTED = Object.entries(RELEASES).flatMap(([tag, publishedAt]) =>
  publishedAt === null ? [] : [tag],
);
// The first release has nothing before it to republish.
const FIRST_RELEASE = "v1.0.0";

type ResolveOptions = {
  readonly minimumVersion: string;
  readonly now: string;
  /** Releases that republished the previous desktop build. */
  readonly carriedForward?: readonly string[];
};

const resolve = ({
  minimumVersion,
  now,
  carriedForward = [],
}: ResolveOptions) => {
  const compared: string[] = [];
  const result = resolveDesktopSupportFloor({
    floor: { minimumVersion, supportDays: SUPPORT_DAYS },
    releases: RELEASES,
    isDesktopBuild: (tag, previousTag) => {
      compared.push(`${previousTag}..${tag}`);
      return !carriedForward.includes(tag);
    },
    now: new Date(now),
  });
  return { compared, result };
};

describe("the desktop support floor", () => {
  test("stays while no newer build is 30 days old", () => {
    // v1.0.3 turns 30 days old on 2026-02-19.
    const { compared, result } = resolve({
      minimumVersion: "1.0.1",
      now: "2026-02-18T23:59:59Z",
    });
    expect(result).toEqual({
      status: "resolved",
      minimumVersion: "1.0.1",
      publishedAt: "2026-01-10T00:00:00Z",
    });
    // v1.0.4 shows a build exists from the floor on; releases younger than 30
    // days are otherwise decided by their date alone.
    expect(compared).toEqual(["v1.0.3..v1.0.4", "v1.0.0..v1.0.1"]);
  });

  test("moves to a build the moment it is 30 days old", () => {
    const { compared, result } = resolve({
      minimumVersion: "1.0.1",
      now: "2026-02-19T00:00:00Z",
    });
    expect(result).toEqual({
      status: "resolved",
      minimumVersion: "1.0.3",
      publishedAt: "2026-01-20T00:00:00Z",
    });
    // The release before v1.0.3 is the promoted one, not the unpromoted tag.
    expect(compared).toEqual(["v1.0.3..v1.0.4", "v1.0.1..v1.0.3"]);
  });

  test("skips a release that republished the previous build", () => {
    expect(
      resolve({
        minimumVersion: "1.0.1",
        now: "2026-02-19T00:00:00Z",
        carriedForward: ["v1.0.3"],
      }).result,
    ).toMatchObject({ status: "resolved", minimumVersion: "1.0.1" });
  });

  test("returns to the supported build when the committed floor is ahead of it", () => {
    expect(
      resolve({ minimumVersion: "1.0.3", now: "2026-02-18T23:59:59Z" }).result,
    ).toMatchObject({ status: "resolved", minimumVersion: "1.0.1" });
  });

  test("a committed floor above every published build is refused", () => {
    expect(
      resolve({
        minimumVersion: "1.0.3",
        now: "2026-03-30T00:00:00Z",
        carriedForward: ["v1.0.3", "v1.0.4"],
      }).result,
    ).toEqual({
      status: "refused",
      message: expect.stringContaining(
        "the desktop support floor 1.0.3 is above every published desktop build",
      ),
    });
  });

  test("a committed floor that is no promoted release is refused", () => {
    for (const minimumVersion of ["1.0.2", "9.9.9"]) {
      expect(
        resolve({ minimumVersion, now: "2026-02-19T00:00:00Z" }).result,
      ).toEqual({
        status: "refused",
        message: expect.stringContaining("is not a promoted release"),
      });
    }
  });

  test("an unreadable publication time is refused", () => {
    expect(
      resolveDesktopSupportFloor({
        floor: { minimumVersion: "1.0.0", supportDays: SUPPORT_DAYS },
        releases: { "v1.0.0": "not a time" },
        isDesktopBuild: () => true,
        now: new Date("2026-03-01T00:00:00Z"),
      }),
    ).toEqual({
      status: "refused",
      message: expect.stringContaining("invalid publication time for v1.0.0"),
    });
  });

  // Every way the four promoted releases can have republished the build
  // before them, at clocks on both sides of each release's 30th day.
  test("never exceeds the newest published desktop build", () => {
    const clocks = [
      "2026-01-15T00:00:00Z",
      "2026-02-05T00:00:00Z",
      "2026-02-12T00:00:00Z",
      "2026-02-25T00:00:00Z",
      "2026-03-20T00:00:00Z",
    ];
    const subsets = Array.from({ length: 2 ** PROMOTED.length }, (_, mask) =>
      PROMOTED.filter((_tag, bit) => Math.floor(mask / 2 ** bit) % 2 === 1),
    );
    const unexpected: string[] = [];
    let resolved = 0;
    for (const carriedForward of subsets) {
      const builds = PROMOTED.filter(
        (tag) => tag === FIRST_RELEASE || !carriedForward.includes(tag),
      );
      const newestBuild = (builds.at(-1) ?? FIRST_RELEASE).slice(1);
      for (const now of clocks) {
        for (const floorTag of PROMOTED) {
          const minimumVersion = floorTag.slice(1);
          const { result } = resolve({ minimumVersion, now, carriedForward });
          const moved =
            result.status === "resolved" ? result.minimumVersion : null;
          // Refused exactly when the committed floor strands users, or when
          // nothing is 30 days old yet.
          const refusalExpected =
            Bun.semver.order(minimumVersion, newestBuild) > 0 ||
            now === clocks.at(0);
          const withinBuilds =
            moved === null ||
            (builds.includes(`v${moved}`) &&
              Bun.semver.order(moved, newestBuild) <= 0);
          if ((moved === null) !== refusalExpected || !withinBuilds) {
            unexpected.push(
              `${minimumVersion} at ${now}, republished: ${carriedForward.join(",")}`,
            );
          }
          resolved += moved === null ? 0 : 1;
        }
      }
    }
    expect(unexpected).toEqual([]);
    expect(resolved).toBeGreaterThan(0);
  });
});

describe("moving the desktop support floor", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });
  const treeWithFloor = (minimumVersion: string): string => {
    const root = mkdtempSync(path.join(tmpdir(), "stella-desktop-floor-"));
    roots.push(root);
    const file = path.join(root, DESKTOP_SUPPORT_FLOOR_PATH);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ minimumVersion, supportDays: SUPPORT_DAYS }, null, 2)}\n`,
    );
    return root;
  };
  const inputs = {
    releases: RELEASES,
    isDesktopBuild: () => true,
    writeFile: writeFileSync,
  };

  test("writes the floor the clock gives, in the committed file's shape", () => {
    for (const now of ["2026-02-18T23:59:59Z", "2026-02-19T00:00:00Z"]) {
      const root = treeWithFloor("1.0.1");
      const clock = new Date(now);
      const computed = resolveDesktopSupportFloor({
        floor: readDesktopSupportFloor(root),
        ...inputs,
        now: clock,
      });

      const move = moveDesktopSupportFloor({
        rootDir: root,
        ...inputs,
        now: clock,
      });

      const written = readDesktopSupportFloor(root);
      expect(computed).toMatchObject({
        status: "resolved",
        minimumVersion: written.minimumVersion,
      });
      expect(move).toEqual({ from: "1.0.1", to: written.minimumVersion });
      expect(written.supportDays).toBe(SUPPORT_DAYS);
      // Byte for byte what the formatter keeps, so an unmoved floor is no diff.
      expect(
        readFileSync(path.join(root, DESKTOP_SUPPORT_FLOOR_PATH), "utf-8"),
      ).toBe(
        `{\n  "minimumVersion": "${written.minimumVersion}",\n  "supportDays": ${String(SUPPORT_DAYS)}\n}\n`,
      );
    }
  });

  test("writes nothing when the committed floor is refused", () => {
    const root = treeWithFloor("1.0.2");
    const before = readFileSync(
      path.join(root, DESKTOP_SUPPORT_FLOOR_PATH),
      "utf-8",
    );
    expect(() =>
      moveDesktopSupportFloor({
        rootDir: root,
        ...inputs,
        now: new Date("2026-02-19T00:00:00Z"),
      }),
    ).toThrow("is not a promoted release");
    expect(
      readFileSync(path.join(root, DESKTOP_SUPPORT_FLOOR_PATH), "utf-8"),
    ).toBe(before);
  });
});

describe("the committed desktop support floor", () => {
  const floor = readDesktopSupportFloor(ROOT);
  const manifest = parseReleaseManifest(
    JSON.parse(
      readFileSync(
        path.join(ROOT, "apps/landing/src/data/changelog-release-dates.json"),
        "utf-8",
      ),
    ),
  );
  if (manifest.status === "invalid") {
    throw new TypeError(manifest.message);
  }
  const { releases } = manifest.manifest;

  test("is a promoted release", () => {
    expect(releases[`v${floor.minimumVersion}`]).toBeString();
  });

  test("accepts the release this checkout builds", () => {
    const version = readFileSync(path.join(ROOT, "VERSION"), "utf-8").trim();
    expect(
      Bun.semver.order(floor.minimumVersion, version),
      `the desktop support floor ${floor.minimumVersion} must not exceed VERSION ${version}`,
    ).toBeLessThanOrEqual(0);
  });

  // The API accepts the desktop's workspace version below the floor by name,
  // which is sound only while no release build can report that version.
  test("lies above the desktop workspace version, as does every release", () => {
    const workspaceVersion =
      /^version = "([^"]+)"$/mu
        .exec(
          readFileSync(
            path.join(ROOT, "apps/desktop/src-tauri/Cargo.toml"),
            "utf-8",
          ),
        )
        ?.at(1) ?? "";
    expect(workspaceVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    const tags = [`v${floor.minimumVersion}`, ...Object.keys(releases)];
    expect(
      tags.filter(
        (tag) => Bun.semver.order(tag.slice(1), workspaceVersion) <= 0,
      ),
    ).toEqual([]);
  });

  test("is checked by the maintenance cut", () => {
    expect(MAINTENANCE_CUT_GATES).toContainEqual({
      name: "desktop-support-floor",
      source: "cut",
      stage: "pre-cut",
      check: {
        kind: "command",
        command: ["bun", "scripts/check-desktop-support-floor.ts"],
      },
      overriddenByAllowUnprovenMain: false,
    });
  });

  test("the desktop rebuild paths are read from their owner", () => {
    expect(readDesktopRebuildPaths(ROOT)).toContain("apps/desktop/");
  });
});
