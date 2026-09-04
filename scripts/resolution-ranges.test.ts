import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  runFixResolutionRanges,
  type RefreshLockfile,
} from "./fix-resolution-ranges";
import {
  analyzeResolutionRanges,
  applyOverridePins,
  collectDeclaredRanges,
  inspectManifestChange,
  lockRangeSources,
  planResolutionRepairs,
  rangeFloor,
  type DeclaredRanges,
  type ResolutionViolation,
} from "./resolution-ranges";

const declaredRanges = (
  entries: Readonly<Record<string, Readonly<Record<string, string>>>>,
): DeclaredRanges =>
  collectDeclaredRanges(
    Object.entries(entries).map(([declaredBy, dependencies]) => ({
      declaredBy,
      manifest: { dependencies },
    })),
  );

const analyze = (
  resolutions: Readonly<Record<string, string>>,
  entries: Readonly<Record<string, Readonly<Record<string, string>>>>,
): readonly ResolutionViolation[] =>
  analyzeResolutionRanges({
    allowedBelowFloor: new Map(),
    declared: declaredRanges(entries),
    rootManifest: { resolutions },
  });

const MANIFEST = `{
  "name": "stella",
  "resolutions": {
    "alpha": "3.0.0",
    "beta": "1.0.0"
  },
  "devDependencies": {
    "alpha": "3.0.0"
  }
}
`;

describe("range floors", () => {
  const cases = [
    { range: "^3.1.0", floor: "3.1.0" },
    { range: "~2.4.5", floor: "2.4.5" },
    { range: ">=1.2.3", floor: "1.2.3" },
    { range: "4.5.6", floor: "4.5.6" },
    { range: "  ^0.1.2 ", floor: "0.1.2" },
    { range: "^1.0.0-beta.1", floor: "1.0.0-beta.1" },
    { range: "^2.0.0 || ^3.0.0", floor: null },
    { range: ">=3.0.0 <4.0.0", floor: null },
    { range: "3.x", floor: null },
    { range: "*", floor: null },
    { range: "workspace:*", floor: null },
    { range: "catalog:", floor: null },
    { range: "npm:other@^1.0.0", floor: null },
    { range: "", floor: null },
  ] as const;

  for (const { range, floor } of cases) {
    it(`reduces ${JSON.stringify(range)} to ${String(floor)}`, () => {
      expect(rangeFloor(range)).toBe(floor);
    });
  }
});

describe("resolution range analysis", () => {
  it("flags a pin below a dependent's floor", () => {
    const violations = analyze(
      { alpha: "3.0.0" },
      { "workspace apps/web": { alpha: "^3.1.0" } },
    );

    expect(violations).toEqual([
      {
        floor: "3.1.0",
        kind: "resolutions",
        packageName: "alpha",
        pinned: "3.0.0",
        requiredBy: [
          { declaredBy: "workspace apps/web", floor: "3.1.0", range: "^3.1.0" },
        ],
      },
    ]);
  });

  it("accepts a pin exactly at the floor", () => {
    expect(
      analyze(
        { alpha: "3.1.0" },
        { "workspace apps/web": { alpha: "^3.1.0" } },
      ),
    ).toEqual([]);
  });

  it("accepts a pin above the floor (a deliberate forward override)", () => {
    expect(
      analyze(
        { alpha: "4.2.0" },
        { "workspace apps/web": { alpha: "^3.1.0" } },
      ),
    ).toEqual([]);
  });

  it("reports the highest floor first across several dependents", () => {
    const [violation] = analyze(
      { alpha: "3.0.0" },
      {
        "alpha-consumer@1.0.0": { alpha: ">=3.4.0" },
        "workspace apps/web": { alpha: "^3.1.0" },
        "workspace packages/ui": { alpha: "~3.2.0" },
      },
    );

    expect(violation?.floor).toBe("3.4.0");
    expect(violation?.requiredBy.map(({ range }) => range)).toEqual([
      ">=3.4.0",
      "~3.2.0",
      "^3.1.0",
    ]);
  });

  it("skips shapes it cannot reduce to one floor", () => {
    expect(
      analyze(
        { alpha: "3.0.0" },
        {
          "workspace apps/web": { alpha: "^3.1.0 || ^4.0.0" },
          "workspace packages/ui": { alpha: "workspace:*" },
        },
      ),
    ).toEqual([]);
  });

  it("skips a pin that is not an exact version", () => {
    expect(
      analyze(
        { alpha: "^3.0.0" },
        { "workspace apps/web": { alpha: "^3.1.0" } },
      ),
    ).toEqual([]);
  });

  it("skips an allowlisted below-floor override", () => {
    expect(
      analyzeResolutionRanges({
        allowedBelowFloor: new Map([["alpha", "held at 3.0.0 on purpose"]]),
        declared: declaredRanges({ "workspace apps/web": { alpha: "^3.1.0" } }),
        rootManifest: { resolutions: { alpha: "3.0.0" } },
      }),
    ).toEqual([]);
  });

  it("checks overrides alongside resolutions", () => {
    const violations = analyzeResolutionRanges({
      allowedBelowFloor: new Map(),
      declared: declaredRanges({ "workspace apps/web": { alpha: "^3.1.0" } }),
      rootManifest: { overrides: { alpha: "3.0.0" } },
    });

    expect(violations.at(0)?.kind).toBe("overrides");
  });

  it("reads ranges from workspaces and resolved packages in bun.lock", () => {
    const declared = collectDeclaredRanges(
      lockRangeSources({
        workspaces: {
          "": { devDependencies: { alpha: "^3.1.0" } },
          "apps/web": { dependencies: { alpha: "^3.2.0" } },
        },
        packages: {
          "beta@1.0.0": [
            "beta@1.0.0",
            "",
            { peerDependencies: { alpha: "^3.3.0" } },
            "sha",
          ],
        },
      }),
    );

    expect(declared.get("alpha")).toEqual([
      { declaredBy: "workspace <root>", range: "^3.1.0" },
      { declaredBy: "workspace apps/web", range: "^3.2.0" },
      { declaredBy: "beta@1.0.0", range: "^3.3.0" },
    ]);
  });
});

describe("resolution repair planning", () => {
  const plan = (
    resolutions: Readonly<Record<string, string>>,
    entries: Readonly<Record<string, Readonly<Record<string, string>>>>,
  ) => {
    const declared = declaredRanges(entries);
    return planResolutionRepairs({
      declared,
      violations: analyzeResolutionRanges({
        allowedBelowFloor: new Map(),
        declared,
        rootManifest: { resolutions },
      }),
    });
  };

  it("raises the pin to the highest floor every dependent accepts", () => {
    expect(
      plan(
        { alpha: "3.0.0" },
        {
          "workspace apps/web": { alpha: "^3.1.0" },
          "workspace packages/ui": { alpha: "^3.4.0" },
        },
      ),
    ).toEqual([
      {
        status: "raise",
        from: "3.0.0",
        kind: "resolutions",
        packageName: "alpha",
        requiredBy: [
          {
            declaredBy: "workspace packages/ui",
            floor: "3.4.0",
            range: "^3.4.0",
          },
          { declaredBy: "workspace apps/web", floor: "3.1.0", range: "^3.1.0" },
        ],
        to: "3.4.0",
      },
    ]);
  });

  it("refuses a floor that no single version can satisfy", () => {
    const [repair] = plan(
      { alpha: "3.0.0" },
      {
        "workspace apps/web": { alpha: "^3.4.0" },
        "workspace packages/ui": { alpha: "3.1.0" },
      },
    );

    expect(repair?.status).toBe("conflict");
    expect(repair).toMatchObject({
      blockedBy: [{ declaredBy: "workspace packages/ui", range: "3.1.0" }],
      packageName: "alpha",
      target: "3.4.0",
    });
  });

  it("refuses to raise out of an upper-bounded range the pin satisfies today", () => {
    const [repair] = plan(
      { alpha: "3.0.0" },
      {
        "workspace apps/web": { alpha: "^3.4.0" },
        "workspace packages/ui": { alpha: ">=3.0.0 <3.1.0" },
      },
    );

    expect(repair?.status).toBe("conflict");
    expect(repair).toMatchObject({
      blockedBy: [
        { declaredBy: "workspace packages/ui", range: ">=3.0.0 <3.1.0" },
      ],
    });
  });

  it("ignores a range the current pin already fails and cannot reach", () => {
    const [repair] = plan(
      { alpha: "3.0.0" },
      {
        "workspace apps/web": { alpha: "^3.4.0" },
        "legacy@1.0.0": { alpha: "^1.0.0" },
      },
    );

    expect(repair).toMatchObject({ status: "raise", to: "3.4.0" });
  });
});

describe("manifest pin rewriting", () => {
  it("writes the floor and leaves every other byte untouched", () => {
    expect(
      applyOverridePins(MANIFEST, [
        { kind: "resolutions", packageName: "alpha", version: "3.4.0" },
      ]),
    ).toBe(MANIFEST.replace('"alpha": "3.0.0",', '"alpha": "3.4.0",'));
  });

  it("never touches a same-named key outside the override map", () => {
    const rewritten = applyOverridePins(MANIFEST, [
      { kind: "resolutions", packageName: "alpha", version: "3.4.0" },
    ]);

    expect(rewritten).toContain('"devDependencies": {\n    "alpha": "3.0.0"');
  });

  it("rewrites several pins at once", () => {
    expect(
      applyOverridePins(MANIFEST, [
        { kind: "resolutions", packageName: "alpha", version: "3.4.0" },
        { kind: "resolutions", packageName: "beta", version: "1.2.0" },
      ]),
    ).toBe(
      MANIFEST.replace('"alpha": "3.0.0",', '"alpha": "3.4.0",').replace(
        '"beta": "1.0.0"',
        '"beta": "1.2.0"',
      ),
    );
  });

  it("refuses a pin the manifest does not declare", () => {
    expect(() =>
      applyOverridePins(MANIFEST, [
        { kind: "resolutions", packageName: "gamma", version: "1.0.0" },
      ]),
    ).toThrow("package.json resolutions has no entry for gamma");
  });

  it("refuses an override map the manifest does not declare", () => {
    expect(() =>
      applyOverridePins(MANIFEST, [
        { kind: "overrides", packageName: "alpha", version: "1.0.0" },
      ]),
    ).toThrow("package.json has no overrides object");
  });
});

describe("generated manifest change boundary", () => {
  const raised = (from: string, to: string): string =>
    MANIFEST.replace(`"alpha": "${from}",`, () => `"alpha": "${to}",`);

  it("accepts an unchanged manifest", () => {
    expect(inspectManifestChange(MANIFEST, MANIFEST)).toEqual({
      status: "unchanged",
    });
  });

  it("accepts a raised pin", () => {
    expect(inspectManifestChange(MANIFEST, raised("3.0.0", "3.4.0"))).toEqual({
      status: "pins-raised",
      changes: [
        {
          from: "3.0.0",
          kind: "resolutions",
          packageName: "alpha",
          to: "3.4.0",
        },
      ],
    });
  });

  const rejections = [
    {
      name: "a lowered pin",
      after: raised("3.0.0", "2.9.0"),
      reason: "was not raised",
    },
    {
      name: "a change to another field",
      after: MANIFEST.replace('"name": "stella"', '"name": "not-stella"'),
      reason: "changed outside resolutions",
    },
    {
      name: "a dependency added next to the pins",
      after: MANIFEST.replace(
        '"beta": "1.0.0"',
        '"beta": "1.0.0",\n    "gamma": "1.0.0"',
      ),
      reason: "keys were added, removed or reordered",
    },
    {
      name: "reformatting around an unchanged pin",
      after: MANIFEST.replace('"name": "stella",', '"name":   "stella",'),
      reason: "without changing any pin",
    },
    {
      name: "reformatting that rides along with a raised pin",
      after: raised("3.0.0", "3.4.0").replace(
        '"name": "stella",',
        '"name":   "stella",',
      ),
      reason: "outside the pinned versions",
    },
    {
      name: "a manifest that stopped being JSON",
      after: `${MANIFEST}trailing`,
      reason: "not a JSON object",
    },
  ] as const;

  for (const { name, after, reason } of rejections) {
    it(`rejects ${name}`, () => {
      const verdict = inspectManifestChange(MANIFEST, after);

      expect(verdict.status).toBe("rejected");
      expect(verdict.status === "rejected" ? verdict.reason : "").toContain(
        reason,
      );
    });
  }

  it("accepts every raise the rewriter produces", () => {
    // Any pin the fixer can write must survive the boundary check: the two
    // sides are one contract, so drift between them would silently red a
    // Dependabot PR the autofix just repaired.
    let state = 7919;
    const random = (bound: number): number => {
      state = (state * 16_807) % 2_147_483_647;
      return state % bound;
    };

    for (let iteration = 0; iteration < 128; iteration += 1) {
      const version = `${3 + random(3)}.${random(20)}.${random(20)}`;
      if (Bun.semver.order(version, "3.0.0") <= 0) {
        continue;
      }
      const after = applyOverridePins(MANIFEST, [
        { kind: "resolutions", packageName: "alpha", version },
      ]);

      expect(inspectManifestChange(MANIFEST, after)).toEqual({
        status: "pins-raised",
        changes: [
          {
            from: "3.0.0",
            kind: "resolutions",
            packageName: "alpha",
            to: version,
          },
        ],
      });
    }
  });
});

describe("fix-resolution-ranges entry point", () => {
  const withRepo = async (
    manifest: string,
    lock: string,
    run: (root: string) => Promise<void>,
  ): Promise<void> => {
    const root = await mkdtemp(path.join(tmpdir(), "resolution-ranges-"));
    try {
      await Bun.write(path.join(root, "package.json"), manifest);
      await Bun.write(path.join(root, "bun.lock"), lock);
      await run(root);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  };

  const lockWith = (...dependencies: readonly string[]): string => `{
  "lockfileVersion": 1,
  "workspaces": {
    "apps/web": {
      "name": "@stll/web",
      "dependencies": { ${dependencies.join(", ")} },
    },
  },
}
`;

  const alpha = (range: string): string => `"alpha": "${range}"`;
  const beta = (range: string): string => `"beta": "${range}"`;

  // The real hook re-resolves bun.lock; a test drives what the next pass reads.
  const refreshWith = (
    locks: readonly string[],
  ): { calls: () => number; refresh: RefreshLockfile } => {
    let calls = 0;
    return {
      calls: () => calls,
      refresh: async (root: string) => {
        const lock = locks.at(calls) ?? locks.at(-1) ?? "";
        calls += 1;
        await Bun.write(path.join(root, "bun.lock"), lock);
      },
    };
  };

  const neverRefresh: RefreshLockfile = () => undefined;

  it("raises the pin in place and leaves the rest of the manifest alone", async () => {
    await withRepo(MANIFEST, lockWith(alpha("^3.4.0")), async (root) => {
      expect(
        await runFixResolutionRanges({ refresh: neverRefresh, root }),
      ).toBe(0);
      expect(await Bun.file(path.join(root, "package.json")).text()).toBe(
        MANIFEST.replace('"alpha": "3.0.0",', '"alpha": "3.4.0",'),
      );
    });
  });

  it("writes nothing when every pin already meets its floor", async () => {
    await withRepo(MANIFEST, lockWith(alpha("^3.0.0")), async (root) => {
      expect(
        await runFixResolutionRanges({ refresh: neverRefresh, root }),
      ).toBe(0);
      expect(await Bun.file(path.join(root, "package.json")).text()).toBe(
        MANIFEST,
      );
    });
  });

  it("fails without writing when the floors conflict", async () => {
    const lock = `{
  "workspaces": {
    "apps/web": { "dependencies": { "alpha": "^3.4.0" } },
    "packages/ui": { "dependencies": { "alpha": "3.1.0" } },
  },
}
`;

    await withRepo(MANIFEST, lock, async (root) => {
      expect(
        await runFixResolutionRanges({ refresh: neverRefresh, root }),
      ).toBe(1);
      expect(await Bun.file(path.join(root, "package.json")).text()).toBe(
        MANIFEST,
      );
    });
  });

  it("repairs a floor that only the refreshed lockfile exposes", async () => {
    // Raising alpha republishes its own metadata, and the refreshed lockfile
    // declares a floor for beta that no earlier pass could see.
    const cascade = refreshWith([
      lockWith(alpha("^3.4.0"), beta("^1.5.0")),
      lockWith(alpha("^3.4.0"), beta("^1.5.0")),
    ]);

    await withRepo(MANIFEST, lockWith(alpha("^3.4.0")), async (root) => {
      expect(
        await runFixResolutionRanges({ refresh: cascade.refresh, root }),
      ).toBe(0);
      expect(cascade.calls()).toBe(2);
      expect(await Bun.file(path.join(root, "package.json")).text()).toBe(
        MANIFEST.replace('"alpha": "3.0.0",', '"alpha": "3.4.0",').replace(
          '"beta": "1.0.0"',
          '"beta": "1.5.0"',
        ),
      );
    });
  });

  it("gives up at the pass cap instead of chasing an endless cascade", async () => {
    // Every refresh raises the floor again, so the fixed point never arrives.
    const endless = refreshWith([
      lockWith(alpha("^3.5.0")),
      lockWith(alpha("^3.6.0")),
      lockWith(alpha("^3.7.0")),
    ]);

    await withRepo(MANIFEST, lockWith(alpha("^3.4.0")), async (root) => {
      expect(
        await runFixResolutionRanges({
          maxPasses: 2,
          refresh: endless.refresh,
          root,
        }),
      ).toBe(1);
      expect(endless.calls()).toBe(2);
      // Two repairs landed, and the third floor the cap refused stays unfixed.
      expect(await Bun.file(path.join(root, "package.json")).text()).toBe(
        MANIFEST.replace('"alpha": "3.0.0",', '"alpha": "3.5.0",'),
      );
    });
  });
});
