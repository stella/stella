import { describe, expect, it } from "bun:test";

import { syncLockfileWorkspaceVersions } from "./lockfile-workspace-versions";

const fixture = `{
  "lockfileVersion": 1,
  "workspaces": {
    "apps/web": {
      "name": "@stll/web",
      "version": "0.0.0",
      "dependencies": {
        "packages/example": "workspace:*"
      },
    },
    "packages/example": {
      "dependencies": {},
      "version": "1.2.3",
      "name": "@stll/example",
    },
  },
  "packages": {
    "packages/example": ["unrelated@1.0.0"],
  },
}
`;

describe("workspace version lockfile synchronization", () => {
  it("changes only direct workspace version values", () => {
    const actual = syncLockfileWorkspaceVersions(fixture, {
      "apps/web": "0.0.1",
      "packages/example": "2.0.0",
    });

    expect(actual).toBe(
      fixture
        .replace('"version": "0.0.0"', '"version": "0.0.1"')
        .replace('"version": "1.2.3"', '"version": "2.0.0"'),
    );
  });

  it("is idempotent", () => {
    const versions = { "apps/web": "0.0.1", "packages/example": "2.0.0" };
    const once = syncLockfileWorkspaceVersions(fixture, versions);
    expect(syncLockfileWorkspaceVersions(once, versions)).toBe(once);
  });

  it("rejects a missing workspace instead of editing a nested lookalike", () => {
    expect(() =>
      syncLockfileWorkspaceVersions(fixture, { "packages/missing": "1.0.0" }),
    ).toThrow('bun.lock is missing property "packages/missing"');
  });
});
