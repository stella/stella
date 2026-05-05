import { describe, expect, it } from "bun:test";

import { compareSemver } from "./semver-compare";

describe("semver comparison", () => {
  it("orders major, minor, and patch segments numerically", () => {
    expect(compareSemver("1.0.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareSemver("1.2.0", "1.10.0")).toBeLessThan(0);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });

  it("treats prereleases as older than their stable version", () => {
    expect(compareSemver("1.2.3", "1.2.3-rc.1")).toBeGreaterThan(0);
    expect(compareSemver("1.2.3-beta.2", "1.2.3")).toBeLessThan(0);
  });

  it("keeps prerelease ordering deterministic", () => {
    expect(compareSemver("1.2.3-rc.2", "1.2.3-beta.1")).toBeGreaterThan(0);
    expect(compareSemver("1.2.3-beta.1", "1.2.3-rc.2")).toBeLessThan(0);
  });
});
