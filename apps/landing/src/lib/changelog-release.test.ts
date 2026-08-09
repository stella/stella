import { describe, expect, test } from "bun:test";

import {
  formatMaintenanceReleaseRange,
  groupMaintenanceReleases,
  getMaintenanceReleaseTitle,
  getReleaseKind,
  isStellaReleaseTag,
} from "./changelog-release";

describe("Stella changelog releases", () => {
  test("accepts stable stella release tags", () => {
    expect(isStellaReleaseTag("v0.6.1")).toBe(true);
    expect(isStellaReleaseTag("v12.34.56")).toBe(true);
  });

  test("rejects package releases and prereleases", () => {
    expect(isStellaReleaseTag("@stll/template-conditions@0.2.0")).toBe(false);
    expect(isStellaReleaseTag("@stll/conditions@0.3.0")).toBe(false);
    expect(isStellaReleaseTag("v0.7.0-rc.1")).toBe(false);
  });

  test("classifies stella versions", () => {
    expect(getReleaseKind("v1.0.0")).toBe("major");
    expect(getReleaseKind("v1.2.0")).toBe("minor");
    expect(getReleaseKind("v1.2.3")).toBe("patch");
  });

  test("folds each consecutive run titled Maintenance release", () => {
    const releases = [
      { tagName: "v0.6.3", title: "Maintenance release" },
      { tagName: "v0.6.2", title: "Maintenance release" },
      { tagName: "v0.6.1", title: "Maintenance release" },
      { tagName: "v0.6.0", title: "Connected tools" },
      { tagName: "v0.5.3", title: "Maintenance release" },
      { tagName: "v0.5.2", title: "Maintenance release" },
    ];

    const entries = groupMaintenanceReleases(releases, ({ title }) => title);
    expect(
      entries.map((entry) =>
        entry.type === "maintenance"
          ? entry.releases.map(({ tagName }) => tagName)
          : entry.release.tagName,
      ),
    ).toEqual([["v0.6.3", "v0.6.2", "v0.6.1"], "v0.6.0", ["v0.5.3", "v0.5.2"]]);
    expect(
      formatMaintenanceReleaseRange(
        [releases[0], releases[1], releases[2]],
        ({ tagName }) => tagName,
      ),
    ).toBe("0.6.1 – 0.6.3");
    expect(
      formatMaintenanceReleaseRange(
        [{ tagName: "v0.6.3", title: "Maintenance release" }],
        ({ tagName }) => tagName,
      ),
    ).toBe("0.6.3");
    expect(getMaintenanceReleaseTitle(1)).toBe("Maintenance release");
    expect(getMaintenanceReleaseTitle(3)).toBe("Maintenance releases");
  });

  test("does not fold titles that only resemble Maintenance release", () => {
    const release = {
      tagName: "v0.6.1",
      title: "Maintenance release notes",
    };

    expect(groupMaintenanceReleases([release], ({ title }) => title)).toEqual([
      { type: "release", release },
    ]);
  });
});
