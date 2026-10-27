import { describe, expect, test } from "bun:test";

import type { Advisory, BaselineEntry } from "./dependency-audit";
import { assessAdvisories } from "./dependency-audit-assessment";

const lockfile = await Bun.file(
  new URL("fixtures/dependency-audit/bun-lock.json", import.meta.url),
).text();
const zod = {
  id: "GHSA-mrhx-c7xc-m3w5",
  package: "zod",
  severity: "high",
  title:
    "Zod can exhaust memory while validating oversized constrained collections",
  vulnerableVersions: "<4.6.6",
} satisfies Advisory;
const sdk = {
  id: "GHSA-22jm-h49p-29qw",
  package: "@modelcontextprotocol/sdk",
  severity: "high",
  title:
    "MCP TypeScript SDK: Experimental tasks were not tied to the session that created them",
  vulnerableVersions: ">=1.24.0 <1.32.0",
} satisfies Advisory;
const acceptance = {
  ...zod,
  owner: "supply-chain",
  reason: "Consumers require major 3",
  expiresOn: "2026-11-23",
  affectedPaths: ["@mcp-ui/client/zod", "@expo/cli/zod"],
} satisfies BaselineEntry;
const versions = new Map([
  ["zod", ["3.25.76", "4.6.5", "4.6.6", "4.6.7"]],
  ["@modelcontextprotocol/sdk", ["1.31.0", "1.32.0", "1.32.1"]],
]);

describe("every advisory is assessed against its actual resolutions", () => {
  test("names all parents that cannot accept a patched major", () => {
    const result = assessAdvisories({
      advisories: [zod],
      accepted: [acceptance],
      lockfile,
      manifest: {},
      versions,
    });
    expect(result).toHaveLength(1);
    const state = result.at(0)?.disposition;
    expect(state?.status).toBe("upstream_blocked");
    if (state?.status !== "upstream_blocked") {
      throw new Error("Expected upstream blockers");
    }
    expect(
      state.blockers.some((blocker) =>
        blocker.includes("@mcp-ui/client requires zod ^3.23.8"),
      ),
    ).toBe(true);
    expect(
      state.blockers.some((blocker) =>
        blocker.includes("@expo/cli requires zod ^3.25.76"),
      ),
    ).toBe(true);
    expect(result.at(0)?.acceptance?.owner).toBe("supply-chain");
  });

  test("a second advisory cannot disappear behind an accepted advisory", () => {
    for (const field of ["resolutions", "overrides"]) {
      const result = assessAdvisories({
        advisories: [zod, sdk],
        accepted: [acceptance],
        lockfile: lockfile.replaceAll(
          "@modelcontextprotocol/sdk@1.32.1",
          "@modelcontextprotocol/sdk@1.31.0",
        ),
        manifest: { [field]: { "@modelcontextprotocol/sdk": "1.31.0" } },
        versions,
      });
      expect(result.map(({ advisory }) => advisory.id)).toEqual([
        zod.id,
        sdk.id,
      ]);
      expect(result.at(1)?.disposition.status).toBe(
        "pinned_resolution_blocked",
      );
      expect(result.at(1)?.action).toContain(
        `package.json ${field}.@modelcontextprotocol/sdk=1.31.0`,
      );
    }
  });

  test("a selectable compatible patch is fix_available", () => {
    const [result] = assessAdvisories({
      advisories: [sdk],
      accepted: [],
      lockfile: lockfile.replaceAll(
        "@modelcontextprotocol/sdk@1.32.1",
        "@modelcontextprotocol/sdk@1.31.0",
      ),
      manifest: {},
      versions,
    });
    expect(result?.disposition.status).toBe("fix_available");
    expect(result?.action).toContain("1.32.1");
  });

  test("an acceptance remains explicit when a compatible patch exists", () => {
    const entry = {
      ...acceptance,
      ...sdk,
      affectedPaths: ["@modelcontextprotocol/sdk"],
    };
    const [result] = assessAdvisories({
      advisories: [sdk],
      accepted: [entry],
      lockfile: lockfile.replaceAll(
        "@modelcontextprotocol/sdk@1.32.1",
        "@modelcontextprotocol/sdk@1.31.0",
      ),
      manifest: {},
      versions,
    });
    expect(result?.disposition.status).toBe("accepted");
    expect(result?.acceptance?.expiresOn).toBe("2026-11-23");
  });

  test("acceptance never extends to a new vulnerable path", () => {
    const newPath = lockfile.replace(
      '"packages": {',
      '"packages": { "new-parent/zod": ["zod@3.25.76", "", {}],',
    );
    expect(() =>
      assessAdvisories({
        advisories: [zod],
        accepted: [acceptance],
        lockfile: newPath,
        manifest: {},
        versions,
      }),
    ).toThrow("does not cover lockfile paths: new-parent/zod");
  });

  test("missing registry evidence and duplicate acceptances fail closed", () => {
    expect(() =>
      assessAdvisories({
        advisories: [zod],
        accepted: [],
        lockfile,
        manifest: {},
        versions: new Map(),
      }),
    ).toThrow("Missing registry versions");
    expect(() =>
      assessAdvisories({
        advisories: [zod],
        accepted: [acceptance, acceptance],
        lockfile,
        manifest: {},
        versions,
      }),
    ).toThrow("Duplicate acceptance");
  });
});

test("every direct manifest requirement participates in pin classification", () => {
  const directLockfile = JSON.stringify({
    packages: {
      "@modelcontextprotocol/sdk": ["@modelcontextprotocol/sdk@1.31.0", "", {}],
    },
  });
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "overrides",
    "resolutions",
  ]) {
    const [result] = assessAdvisories({
      advisories: [sdk],
      accepted: [],
      lockfile: directLockfile,
      manifest: { [field]: { "@modelcontextprotocol/sdk": "1.31.0" } },
      versions,
    });
    expect(result?.disposition.status).toBe("pinned_resolution_blocked");
    expect(result?.action).toContain(
      `package.json ${field}.@modelcontextprotocol/sdk=1.31.0`,
    );
  }
});

test("direct requirements can permit a patched release in another major", () => {
  const [result] = assessAdvisories({
    advisories: [{ ...sdk, vulnerableVersions: ">=1.24.0 <2.0.0" }],
    accepted: [],
    lockfile: JSON.stringify({
      packages: {
        "@modelcontextprotocol/sdk": [
          "@modelcontextprotocol/sdk@1.31.0",
          "",
          {},
        ],
      },
    }),
    manifest: { dependencies: { "@modelcontextprotocol/sdk": ">=1.31.0" } },
    versions: new Map([["@modelcontextprotocol/sdk", ["1.31.0", "2.0.0"]]]),
  });
  expect(result?.disposition.status).toBe("fix_available");
});

test("safe releases below the affected range never count as patched upgrades", () => {
  const advisory = {
    ...sdk,
    package: "example",
    vulnerableVersions: ">=2.0.0 <2.3.1",
  };
  const directLockfile = JSON.stringify({
    packages: { example: ["example@2.2.0", "", {}] },
  });
  for (const published of [
    ["1.9.0", "2.2.0", "2.3.1"],
    ["1.9.0", "2.2.0"],
  ]) {
    const [result] = assessAdvisories({
      advisories: [advisory],
      accepted: [],
      lockfile: directLockfile,
      manifest: { resolutions: { example: ">=1.0.0 <2.3.1" } },
      versions: new Map([["example", published]]),
    });
    const state = result?.disposition;
    expect(state?.status).toBe(
      published.includes("2.3.1")
        ? "pinned_resolution_blocked"
        : "upstream_blocked",
    );
    if (
      state?.status !== "pinned_resolution_blocked" &&
      state?.status !== "upstream_blocked"
    ) {
      throw new Error("Expected a blocked upgrade");
    }
    expect(state.patchedVersions).toEqual(
      published.includes("2.3.1") ? ["2.3.1"] : [],
    );
    expect(result?.action).not.toContain("1.9.0");
  }
});

const multiLineAssessment = ({
  locked,
  requirement,
  published,
}: {
  locked: string;
  requirement: string;
  published: string[];
}) =>
  assessAdvisories({
    advisories: [
      {
        ...sdk,
        package: "example",
        vulnerableVersions: ">=1.0.0 <1.2.3 || >=2.0.0 <2.1.1",
      },
    ],
    accepted: [],
    lockfile: JSON.stringify({
      packages: {
        app: ["app@1.0.0", "", { dependencies: { example: requirement } }],
        example: [`example@${locked}`, "", {}],
      },
    }),
    manifest: {},
    versions: new Map([["example", published]]),
  }).at(0)?.disposition;

test("an advisory spanning release lines keeps each line's forward patch", () => {
  expect(
    multiLineAssessment({
      locked: "1.2.2",
      requirement: "^1.0.0",
      published: ["1.2.2", "1.2.3", "2.1.0", "2.1.1"],
    }),
  ).toEqual({ status: "fix_available", patchedVersions: ["1.2.3", "2.1.1"] });
});

test("a workspace manifest pin blocks the fix like a root pin", () => {
  const [result] = assessAdvisories({
    advisories: [{ ...sdk, package: "example", vulnerableVersions: "<1.0.1" }],
    accepted: [],
    lockfile: JSON.stringify({
      workspaces: {
        "": { name: "root" },
        "apps/web": { name: "web", dependencies: { example: "1.0.0" } },
      },
      packages: { example: ["example@1.0.0", "", {}] },
    }),
    manifest: {},
    versions: new Map([["example", ["1.0.0", "1.0.1"]]]),
  });
  expect(result?.disposition).toEqual({
    status: "pinned_resolution_blocked",
    pins: ["apps/web/package.json dependencies.example=1.0.0"],
    patchedVersions: ["1.0.1"],
  });
});

test("a root requirement never hides a locked copy without a forward patch", () => {
  const [result] = assessAdvisories({
    advisories: [
      {
        ...sdk,
        package: "example",
        vulnerableVersions: ">=1.0.0 <1.2.3 || >=2.0.0 <2.1.1",
      },
    ],
    accepted: [],
    lockfile: JSON.stringify({
      packages: {
        example: ["example@1.2.2", "", {}],
        "other/example": ["example@2.1.0", "", {}],
      },
    }),
    manifest: { dependencies: { example: ">=1.0.0" } },
    versions: new Map([["example", ["1.2.2", "1.2.3", "2.1.0"]]]),
  });
  expect(result?.disposition).toEqual({
    status: "upstream_blocked",
    blockers: [
      "other/example@2.1.0: no forward patched release allowed by package.json",
    ],
    patchedVersions: ["1.2.3"],
  });
});

test("a patch on an older release line is no upgrade for a newer locked copy", () => {
  expect(
    multiLineAssessment({
      locked: "2.1.0",
      requirement: ">=1.0.0",
      published: ["1.2.3", "2.1.0"],
    })?.status,
  ).toBe("upstream_blocked");
});
