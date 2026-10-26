import { panic } from "better-result";
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";
import { sha256Hex } from "@stll/sha256/bun";

import { IN_PROCESS_DEPENDENCIES } from "../packages/external-contracts/src/dependency-dispositions";
import {
  findTotalityProblems,
  findVersionDrift,
} from "../packages/external-contracts/src/guard";
import { EXTERNAL_CONTRACTS } from "../packages/external-contracts/src/registry";
import type {
  ExternalContractEntry,
  PinSource,
} from "../packages/external-contracts/src/types";
import {
  admittedPinDrift,
  baselinePinSourceFiles,
  checkContractEntry,
  checkExternalContracts,
  findDependencyCatalogProblems,
  findShrinkOnlyGrowth,
  hasChangedExecutableUsage,
  hasChangedLocalRuntimeClosure as compareLocalRuntimeClosure,
  inProcessFromSource,
  lockKeyPackageName,
  readBaselinePins,
  readCurrentPins,
  readDirectDependencies,
  readExternalSdks,
  readPin,
  REMOVED_PIN,
  uncharacterisedFromSource,
  uncharacterisedScopeFromSource,
} from "./check-external-contracts";
import {
  createLocalRuntimeClosureReader as readLocalClosure,
  type RuntimeSnapshotReader,
} from "./external-contract-evidence";
import {
  createGitBaselineReader,
  readGitWorkingTreeBlobIds,
} from "./offline-git-read";
import {
  OUTBOUND_TRANSPORT_CENSUS,
  type OutboundTransportCensusEntry,
} from "./outbound-transport-census";

// Map fixtures model object identity without a Git repository; production readers use tree metadata.
const withBlobIds = (read: RuntimeSnapshotReader): RuntimeSnapshotReader => {
  if (read.blobId !== undefined) {
    return read;
  }
  return Object.assign((file: string) => read(file), {
    files: read.files,
    byteLength: read.byteLength,
    blobId: (file: string) => {
      const text = read(file);
      return text === undefined
        ? undefined
        : sha256Hex(
            `blob ${new TextEncoder().encode(text).byteLength}\0${text}`,
          );
    },
  });
};
const hasChangedLocalRuntimeClosure = (
  options: Omit<Parameters<typeof compareLocalRuntimeClosure>[0], "scope">,
) =>
  compareLocalRuntimeClosure({
    ...options,
    scope: "sdk-reachable",
    baseline: withBlobIds(options.baseline),
    current: withBlobIds(options.current),
  });
const createLocalRuntimeClosureReader = (
  options: Parameters<typeof readLocalClosure>[0],
) => readLocalClosure({ ...options, read: withBlobIds(options.read) });

const ROOT = path.resolve(import.meta.dir, "..");

test("baseline hydration derives every file read for declared pin sources", () => {
  const files = baselinePinSourceFiles(EXTERNAL_CONTRACTS);
  expect(files).toContain("scripts/ci-service-images.json");
  expect(files).toContain("package.json");
  expect(files).toContain("bun.lock");

  for (const entry of Object.values(EXTERNAL_CONTRACTS)) {
    for (const source of entry.pinSources) {
      expect(files).toContain(source.file);
    }
  }
});

test("a partial clone hydrates a changed baseline service-image pin before offline comparison", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "external-pin-partial-"));
  try {
    const source = path.join(fixture, "source");
    const checkout = path.join(fixture, "checkout");
    const runGit = (cwd: string, args: readonly string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return result.stdout.toString().trim();
    };
    runGit(fixture, ["init", "-b", "main", source]);
    runGit(source, ["config", "user.name", "Contract Test"]);
    runGit(source, ["config", "user.email", "contract@example.invalid"]);
    runGit(source, ["config", "uploadpack.allowFilter", "true"]);
    writeFileSync(path.join(source, "package.json"), "{}");
    writeFileSync(path.join(source, "bun.lock"), '{"packages":{}}');
    mkdirSync(path.join(source, "scripts"));
    const imageFile = "scripts/ci-service-images.json";
    writeFileSync(
      path.join(source, imageFile),
      '[{"name":"postgres","source":"postgres@sha256:old"}]',
    );
    runGit(source, ["add", "."]);
    runGit(source, ["commit", "-m", "baseline"]);
    const base = runGit(source, ["rev-parse", "HEAD"]);
    writeFileSync(
      path.join(source, imageFile),
      '[{"name":"postgres","source":"postgres@sha256:new"}]',
    );
    runGit(source, ["commit", "-am", "head"]);
    runGit(fixture, [
      "clone",
      "--filter=blob:none",
      `file://${source}`,
      checkout,
    ]);

    const entry = {
      owners: [],
      sdks: [],
      pinSources: [{ type: "image", file: imageFile, name: "postgres" }],
      driftTriggers: ["pin-bump"],
      status: "uncharacterised",
      reason: "Fixture-only contract.",
    } as const satisfies ExternalContractEntry;
    for (const file of baselinePinSourceFiles({ fixture: entry })) {
      runGit(checkout, ["show", `${base}:${file}`]);
    }
    const baseline = readBaselinePins(
      entry,
      createGitBaselineReader({ root: checkout, base }),
    );
    const current = readCurrentPins(checkout, entry);
    const report = findVersionDrift({
      system: "postgres",
      fixture: "receipt",
      current,
      characterisedAt: baseline,
    }).join("\n");
    expect(report).toContain("re-characterise postgres at postgres@sha256:new");
    expect(report).not.toContain("ExternalContractBaselineUnavailable");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
const directDependencies = readDirectDependencies(ROOT);
const realBaseline = createGitBaselineReader({
  root: ROOT,
  base: process.env["CHECK_BASE_REF"] ?? "origin/main",
});
const plantedOwner = {
  path: "apps/api/src/lib/example-unregistered-client.ts",
  class: "third-party",
  reason: "Sends requests to an example service.",
  transports: ["global:fetch"],
} as const satisfies OutboundTransportCensusEntry;

test("the real outbound census and SDK manifests have total offline coverage", () => {
  expect(checkExternalContracts(ROOT, { baseline: realBaseline })).toEqual([]);
  expect(
    findDependencyCatalogProblems({
      dependencies: directDependencies,
      census: [...OUTBOUND_TRANSPORT_CENSUS, plantedOwner],
    }).join("\n"),
  ).toContain(`owner ${plantedOwner.path} maps to 0`);
  expect(
    findDependencyCatalogProblems({
      dependencies: directDependencies,
      sdks: [...readExternalSdks(ROOT), "@example/sdk"],
    }).join("\n"),
  ).toContain("SDK @example/sdk maps to 0");
  const owners = OUTBOUND_TRANSPORT_CENSUS.map(({ path: owner }) => owner);
  expect(
    findTotalityProblems({
      registry: EXTERNAL_CONTRACTS,
      owners: [...owners, plantedOwner.path],
      sdks: readExternalSdks(ROOT),
    }).join("\n"),
  ).toContain(`owner ${plantedOwner.path} maps to 0`);
  expect(
    findTotalityProblems({
      registry: EXTERNAL_CONTRACTS,
      owners,
      sdks: [...readExternalSdks(ROOT), "@example/sdk"],
    }).join("\n"),
  ).toContain("SDK @example/sdk maps to 0");
}, 60_000);

test("the closed dependency census includes clients without SDK-shaped names", () => {
  expect(readExternalSdks(ROOT)).toContain("posthog-js");
  expect(readExternalSdks(ROOT)).toContain("@hocuspocus/provider");
  expect(readExternalSdks(ROOT)).toContain("@hocuspocus/extension-redis");
  expect(
    findDependencyCatalogProblems({
      dependencies: [...directDependencies, "new-vendor-client"],
    }).join("\n"),
  ).toContain("Dependency new-vendor-client: classify it");
});

test("publisher captures require a characterised contract", () => {
  const publisher = EXTERNAL_CONTRACTS["legal-publishers"];
  const registry = {
    ...EXTERNAL_CONTRACTS,
    "legal-publishers": {
      owners: publisher.owners,
      sdks: publisher.sdks,
      pinSources: publisher.pinSources,
      driftTriggers: publisher.driftTriggers,
      status: "uncharacterised",
      reason: "The publisher replay corpus is not enrolled.",
    },
  } as const;
  expect(
    checkExternalContracts(ROOT, { baseline: realBaseline, registry }),
  ).toEqual(["The legal-publishers contract must be characterised."]);
});

test("shared scope needs a refreshed receipt and a runtime-reachable replay import", () => {
  const root = mkdtempSync(path.join(tmpdir(), "external-contract-shared-"));
  try {
    const contract = EXTERNAL_CONTRACTS.quickwit;
    const fixture = contract.fixtures[0];
    const receiptPath = path.join(root, "quickwit.source.json");
    const originalReceipt: unknown = JSON.parse(
      readFileSync(path.join(ROOT, fixture.metadata), "utf-8"),
    );
    const sharedOwner = EXTERNAL_CONTRACTS.postgres.owners[0].path;
    const registry = {
      ...EXTERNAL_CONTRACTS,
      quickwit: {
        ...contract,
        owners: [...contract.owners, { path: sharedOwner, role: "shared" }],
        fixtures: [
          { ...fixture, metadata: repoRelativePath(ROOT, receiptPath) },
        ],
      },
    } as const;
    writeFileSync(receiptPath, JSON.stringify(originalReceipt));
    const problems = checkContractEntry({
      root: ROOT,
      system: "quickwit",
      entry: registry.quickwit,
      baseline: undefined,
      admitted: undefined,
      now: new Date(),
    });
    expect(problems.join("\n")).toContain(
      `owner ${sharedOwner} has no reachable fixture receipt`,
    );
    writeFileSync(
      receiptPath,
      JSON.stringify({
        characterisedAt: readCurrentPins(ROOT, contract),
        fixtureSet: fixture.path,
        provenance: fixture.provenance,
        coveredOwners: registry.quickwit.owners.map(({ path: owner }) => owner),
        coveredSdks: contract.sdks,
      }),
    );
    expect(
      checkContractEntry({
        root: ROOT,
        system: "quickwit",
        entry: registry.quickwit,
        baseline: undefined,
        admitted: undefined,
        now: new Date(),
      }).join("\n"),
    ).toContain(`owner claim ${sharedOwner} is not runtime-reachable`);
    const replayPath = path.join(root, "shared-replay.test.ts");
    writeFileSync(
      replayPath,
      `import ${JSON.stringify(path.join(ROOT, sharedOwner))};`,
    );
    const refreshedRegistry = {
      ...registry,
      quickwit: {
        ...registry.quickwit,
        fixtures: [
          {
            ...registry.quickwit.fixtures[0],
            replayFiles: [
              ...fixture.replayFiles,
              repoRelativePath(ROOT, replayPath),
            ],
          },
        ],
      },
    } as const;
    expect(
      checkContractEntry({
        root: ROOT,
        system: "quickwit",
        entry: refreshedRegistry.quickwit,
        baseline: undefined,
        admitted: undefined,
        now: new Date(),
      }),
    ).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("literal source inspection binds the shrink-only set to entry statuses", () => {
  const source = readFileSync(
    path.join(ROOT, "packages/external-contracts/src/registry.ts"),
    "utf-8",
  );
  expect(uncharacterisedFromSource(source).toSorted()).toEqual(
    Object.entries(EXTERNAL_CONTRACTS)
      .filter(([, entry]) => entry.status === "uncharacterised")
      .map(([id]) => id)
      .toSorted(),
  );
});

test("a planted receipt cannot claim an owner outside its replay graph", () => {
  const root = mkdtempSync(path.join(tmpdir(), "external-contract-forged-"));
  try {
    const contract = EXTERNAL_CONTRACTS.quickwit;
    const fixture = contract.fixtures[0];
    const receiptPath = path.join(root, "forged.source.json");
    const replayPath = path.join(root, "unrelated-replay.test.ts");
    writeFileSync(replayPath, "export const unrelated = true;");
    writeFileSync(
      receiptPath,
      JSON.stringify({
        characterisedAt: readCurrentPins(ROOT, contract),
        fixtureSet: fixture.path,
        provenance: fixture.provenance,
        coveredOwners: contract.owners.map(({ path: owner }) => owner),
        coveredSdks: contract.sdks,
      }),
    );
    const registry = {
      ...EXTERNAL_CONTRACTS,
      quickwit: {
        ...contract,
        fixtures: [
          {
            ...fixture,
            metadata: repoRelativePath(ROOT, receiptPath),
            replayFiles: [repoRelativePath(ROOT, replayPath)],
          },
        ],
      },
    } as const;
    const problems = checkContractEntry({
      root: ROOT,
      system: "quickwit",
      entry: registry.quickwit,
      baseline: undefined,
      admitted: undefined,
      now: new Date(),
    });
    for (const { path: owner } of contract.owners) {
      expect(problems.join("\n")).toContain(
        `owner claim ${owner} is not runtime-reachable`,
      );
    }
    expect(problems.join("\n")).toContain("has no reachable fixture receipt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("literal classification sources bind dependency and uncovered keys without executing modules", () => {
  const ledger =
    'export const IN_PROCESS_DEPENDENCIES = { "local-one": "Local parsing." } as const;';
  const registry = `export const EXTERNAL_CONTRACTS = {
    fixture: { status: "characterised", uncharacterisedScope: {
      owners: [{ path: "owner.ts", reason: "Replay pending." }],
      sdks: [{ package: "remote-sdk", reason: "Capture pending." }]
    } },
    other: { status: "uncharacterised", reason: "Pending.", owners: [{ path: "other.ts", role: "primary" }], sdks: ["other-sdk"] }
  } as const;`;
  expect(inProcessFromSource(ledger)).toEqual(["local-one"]);
  expect(uncharacterisedScopeFromSource(registry)).toEqual([
    "fixture#owners:owner.ts",
    "fixture#sdks:remote-sdk",
    "other#owners:other.ts",
    "other#sdks:other-sdk",
  ]);
  expect(
    findShrinkOnlyGrowth({
      current: ["fixture#owners:new.ts"],
      baseline: uncharacterisedScopeFromSource(registry),
      label: "Uncharacterised scope",
    }).join("\n"),
  ).toContain("Uncharacterised scope fixture#owners:new.ts");
  expect(
    uncharacterisedScopeFromSource(
      'export const EXTERNAL_CONTRACTS = { fixture: { status: "characterised" } } as const;',
    ),
  ).toEqual([]);
});

test("whole uncharacterised contracts can promote uncovered subsets without admitting new surfaces", () => {
  const baselineSource = `export const EXTERNAL_CONTRACTS = {
    fixture: { status: "uncharacterised", reason: "Captures pending.", owners: [
      { path: "covered.ts", role: "primary" }, { path: "pending.ts", role: "shared" }
    ], sdks: ["covered-sdk", "pending-sdk"] }
  } as const;`;
  const partialSource = `export const EXTERNAL_CONTRACTS = {
    fixture: { status: "characterised", uncharacterisedScope: {
      owners: [{ path: "pending.ts", reason: "Replay pending." }],
      sdks: [{ package: "pending-sdk", reason: "Capture pending." }]
    } }
  } as const;`;
  const baseline = uncharacterisedScopeFromSource(baselineSource);
  const current = uncharacterisedScopeFromSource(partialSource);
  expect(baseline).toEqual([
    "fixture#owners:covered.ts",
    "fixture#owners:pending.ts",
    "fixture#sdks:covered-sdk",
    "fixture#sdks:pending-sdk",
  ]);
  expect(current).toEqual([
    "fixture#owners:pending.ts",
    "fixture#sdks:pending-sdk",
  ]);
  expect(
    findShrinkOnlyGrowth({ current, baseline, label: "Uncharacterised scope" }),
  ).toEqual([]);
  const expandedWhole = baselineSource
    .replace('"pending.ts"', '"new-owner.ts"')
    .replace('"pending-sdk"', '"new-sdk"');
  expect(
    findShrinkOnlyGrowth({
      current: uncharacterisedScopeFromSource(expandedWhole),
      baseline,
      label: "Uncharacterised scope",
    }),
  ).toEqual([
    "Uncharacterised scope fixture#owners:new-owner.ts: classification keys only shrink; add runtime characterisation instead of expanding the exemption.",
    "Uncharacterised scope fixture#sdks:new-sdk: classification keys only shrink; add runtime characterisation instead of expanding the exemption.",
  ]);
  expect(
    findShrinkOnlyGrowth({
      current: uncharacterisedScopeFromSource(
        partialSource.replace('"pending.ts"', '"new-owner.ts"'),
      ),
      baseline,
      label: "Uncharacterised scope",
    }),
  ).toEqual([
    "Uncharacterised scope fixture#owners:new-owner.ts: classification keys only shrink; add runtime characterisation instead of expanding the exemption.",
  ]);
});

const expectedUncoveredScope = (
  system: string,
  entry: ExternalContractEntry,
) => {
  switch (entry.status) {
    case "characterised":
      return [
        ...entry.uncharacterisedScope.owners.map(
          ({ path: owner }) => `${system}#owners:${owner}`,
        ),
        ...entry.uncharacterisedScope.sdks.map(
          ({ package: sdk }) => `${system}#sdks:${sdk}`,
        ),
      ];
    case "uncharacterised":
      return [
        ...entry.owners.map(({ path: owner }) => `${system}#owners:${owner}`),
        ...entry.sdks.map((sdk) => `${system}#sdks:${sdk}`),
      ];
    default:
      entry satisfies never;
      return panic("Unhandled external contract status");
  }
};

test("all uncovered surfaces and in-process AST ledgers match their declared keys", () => {
  expect(
    inProcessFromSource(
      readFileSync(
        path.join(
          ROOT,
          "packages/external-contracts/src/dependency-dispositions.ts",
        ),
        "utf-8",
      ),
    ).toSorted(),
  ).toEqual(Object.keys(IN_PROCESS_DEPENDENCIES).toSorted());
  const expected = Object.entries(EXTERNAL_CONTRACTS).flatMap(
    ([system, entry]) => expectedUncoveredScope(system, entry),
  );
  expect(
    uncharacterisedScopeFromSource(
      readFileSync(
        path.join(ROOT, "packages/external-contracts/src/registry.ts"),
        "utf-8",
      ),
    ).toSorted(),
  ).toEqual(expected.toSorted());
});

test("pin readers observe edits to manifests, images, API constants, locks and patches", () => {
  const root = mkdtempSync(path.join(tmpdir(), "external-contract-pins-"));
  try {
    mkdirSync(path.join(root, "patches"));
    writeFileSync(path.join(root, "patches/client.patch"), "initial patch");
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        catalog: { client: "1.0.0" },
        patchedDependencies: { "client@1.0.0": "patches/client.patch" },
      }),
    );
    writeFileSync(
      path.join(root, "bun.lock"),
      JSON.stringify({
        packages: { client: ["client@1.0.0", "", {}, "sha512:test"] },
      }),
    );
    writeFileSync(
      path.join(root, "images.json"),
      JSON.stringify([{ name: "engine", source: "engine@sha256:old" }]),
    );
    writeFileSync(
      path.join(root, "contract.ts"),
      'export const API_VERSIONS = ["v1"] as const;',
    );
    const entry = {
      ...EXTERNAL_CONTRACTS["identity-services"],
      sdks: ["client"],
      pinSources: [
        {
          type: "manifest",
          file: "package.json",
          section: "catalog",
          package: "client",
        },
      ],
    } as const;
    const original = readCurrentPins(root, entry);
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        catalog: { client: "2.0.0" },
        patchedDependencies: { "client@1.0.0": "patches/client.patch" },
      }),
    );
    expect(
      findVersionDrift({
        system: "client",
        fixture: "receipt",
        current: readCurrentPins(root, entry),
        characterisedAt: original,
      }).join("\n"),
    ).toContain("re-characterise client at 2.0.0");
    writeFileSync(
      path.join(root, "bun.lock"),
      JSON.stringify({
        packages: { client: ["client@2.0.0", "", {}, "sha512:test"] },
      }),
    );
    expect(
      findVersionDrift({
        system: "client",
        fixture: "receipt",
        current: readCurrentPins(root, entry),
        characterisedAt: original,
      }).join("\n"),
    ).toContain("re-characterise client at client@2.0.0");
    const beforePatch = readCurrentPins(root, entry);
    writeFileSync(path.join(root, "patches/client.patch"), "changed patch");
    expect(
      findVersionDrift({
        system: "client",
        fixture: "receipt",
        current: readCurrentPins(root, entry),
        characterisedAt: beforePatch,
      }).join("\n"),
    ).toContain("patchedDependencies.client@1.0.0");
    expect(
      readPin(root, { type: "image", file: "images.json", name: "engine" }),
    ).toBe("engine@sha256:old");
    writeFileSync(
      path.join(root, "images.json"),
      JSON.stringify([{ name: "engine", source: "engine@sha256:new" }]),
    );
    expect(
      readPin(root, { type: "image", file: "images.json", name: "engine" }),
    ).toBe("engine@sha256:new");
    expect(
      readPin(root, {
        type: "constant",
        file: "contract.ts",
        name: "API_VERSIONS",
      }),
    ).toBe('["v1"]');
    writeFileSync(
      path.join(root, "contract.ts"),
      'export const API_VERSIONS = ["v2"] as const;',
    );
    expect(
      readPin(root, {
        type: "constant",
        file: "contract.ts",
        name: "API_VERSIONS",
      }),
    ).toBe('["v2"]');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("new in-process dependencies require reasons and stay in the closed dependency census", () => {
  const dependencies = [...directDependencies, "@stll/new-local"];
  for (const reason of ["Local workspace implementation.", "", "  "]) {
    const problems = findDependencyCatalogProblems({
      dependencies,
      inProcess: { ...IN_PROCESS_DEPENDENCIES, "@stll/new-local": reason },
    });
    expect(problems).toEqual(
      reason.trim() === ""
        ? [
            "@stll/new-local: non-external dependency classification requires a reason.",
          ]
        : [],
    );
  }
  const unclassified = findDependencyCatalogProblems({ dependencies });
  expect(unclassified.join("\n")).toContain(
    "Dependency @stll/new-local: classify it",
  );
  expect(unclassified.join("\n")).toContain("SDK @stll/new-local maps to 0");
});

test.each([
  ["nodemailer", "nodemailer"],
  ["@types/nodemailer", "@types/nodemailer"],
  ["@ai-sdk/openai", "@ai-sdk/openai"],
  ["openai", "openai"],
  ["some-parent/openai", "openai"],
  ["@scope/parent/openai", "openai"],
  ["some-parent/@ai-sdk/openai", "@ai-sdk/openai"],
  ["@scope/parent/@types/ioredis", "@types/ioredis"],
])("bun.lock key %s names package %s", (key, name) => {
  expect(lockKeyPackageName(key)).toBe(name);
});

test("a scoped package sharing an SDK base name is not that SDK", () => {
  for (const key of ["@types/nodemailer", "@ai-sdk/openai", "@types/ioredis"]) {
    expect(lockKeyPackageName(key)).not.toBe(key.split("/").at(-1));
  }
});

const pinDebt = {
  id: "example-2026-10-14",
  system: "example",
  pins: { sdk: "2", oldPatch: REMOVED_PIN },
  checkedAt: "2026-10-14T00:00:00.000Z",
  expiresAt: "2026-10-21T00:00:00.000Z",
  reason: "Existing pin drift needs replay evidence.",
};

test("dated drift admits only unchanged pins before its exact deadline", () => {
  const options = {
    current: { sdk: "2" },
    baseline: { sdk: "2" },
    allowance: pinDebt,
    now: new Date("2026-10-20T23:59:59.999Z"),
    usageChanged: false,
  };
  expect(admittedPinDrift(options)).toEqual(pinDebt.pins);
  expect(admittedPinDrift({ ...options, current: { sdk: "3" } })).toEqual({
    oldPatch: REMOVED_PIN,
  });
  expect(admittedPinDrift({ ...options, baseline: { sdk: "1" } })).toEqual({
    oldPatch: REMOVED_PIN,
  });
  expect(admittedPinDrift({ ...options, usageChanged: true })).toEqual({});
  expect(
    admittedPinDrift({ ...options, now: new Date(pinDebt.expiresAt) }),
  ).toEqual({});
  for (const [changed, reason] of [
    [
      { ...options, usageChanged: true },
      "runtime closure changed or could not be resolved",
    ],
    [
      { ...options, now: new Date(pinDebt.expiresAt) },
      `dated allowance ${pinDebt.id} expired`,
    ],
    [
      { ...options, current: { sdk: "3" } },
      "current pin differs from the exact dated allowance",
    ],
    [
      { ...options, baseline: { sdk: "1" } },
      "merge-base pin differs from the exact dated allowance",
    ],
  ] as const) {
    const reasons = new Map<string, string>();
    admittedPinDrift({
      ...changed,
      onRejected: (key, rejected) => {
        reasons.set(key, rejected);
      },
    });
    expect(reasons.get("sdk")).toBe(reason);
  }
});

test("executable changes in SDK importers invalidate dated debt while comments do not", () => {
  const options = {
    sdks: ["vendor"],
    file: "client.ts",
    baseline: 'import sdk from "vendor"; sdk.send("old");',
    current: 'import sdk from "vendor"; sdk.send("new");',
  };
  expect(hasChangedExecutableUsage(options)).toBe(true);
  expect(hasChangedExecutableUsage({ ...options, baseline: undefined })).toBe(
    true,
  );
  expect(
    hasChangedExecutableUsage({
      ...options,
      current: `// comment\n${options.baseline}`,
    }),
  ).toBe(false);
  expect(
    hasChangedExecutableUsage({
      ...options,
      current: 'import sdk from "vendor";',
    }),
  ).toBe(true);
});

test("duplicate added SDK calls count as changed usage", () => {
  const baseline = 'import sdk from "vendor"; sdk.send("old");';
  expect(
    hasChangedExecutableUsage({
      sdks: ["vendor"],
      file: "client.ts",
      baseline,
      current: `${baseline} sdk.send("old");`,
    }),
  ).toBe(true);
});

test("receipt bookkeeping in a file without a pinned SDK import keeps dated debt", () => {
  const usage = 'const receipt = { pin: "old" };';
  expect(
    hasChangedExecutableUsage({
      sdks: ["vendor"],
      file: "client.ts",
      baseline: usage,
      current: `${usage} const receipt = { pin: "old" };`,
    }),
  ).toBe(false);
});

test.each([
  'const client = sdk.createClient(); client.send("old");',
  'const client = sdk; client.send("old");',
  'const { send } = sdk; send("old");',
])("changes through derived SDK values invalidate dated debt: %s", (use) => {
  const baseline = `import sdk from "vendor"; ${use}`;
  expect(
    hasChangedExecutableUsage({
      sdks: ["vendor"],
      file: "client.ts",
      baseline,
      current: baseline.replace('"old"', '"new"'),
    }),
  ).toBe(true);
});
test("comment and type-only edits in SDK importers keep dated debt", () => {
  const baseline =
    'import sdk from "vendor"; const client = sdk.createClient(); client.send("old");';
  const current = `// note\nimport type { Client } from "vendor"; interface Receipt { pin: string } type Pin = string; ${baseline.replace("const client =", "const client: Client =")}`;
  expect(
    hasChangedExecutableUsage({
      sdks: ["vendor"],
      file: "client.ts",
      baseline,
      current,
    }),
  ).toBe(false);
});
test("unrelated executable edits in SDK importers also invalidate dated debt", () => {
  const baseline = 'import sdk from "vendor"; sdk.send("old");';
  expect(
    hasChangedExecutableUsage({
      sdks: ["vendor"],
      file: "client.ts",
      baseline,
      current: `${baseline} const receipt = { pin: "old" };`,
    }),
  ).toBe(true);
});

test.each([
  'import sdk = require("vendor"); sdk.send("new");',
  'const sdk = await import(`vendor`); sdk.send("new");',
  'const moduleName = "vendor"; const sdk = await import(moduleName); sdk.send("new");',
])("introduced SDK module references invalidate dated debt: %s", (current) => {
  expect(
    hasChangedExecutableUsage({
      sdks: ["vendor"],
      file: "client.ts",
      baseline: 'const receipt = { pin: "old" };',
      current,
    }),
  ).toBe(true);
});
test("non-literal module references invalidate even unchanged pinned owners", () => {
  const source = "const sdk = await import(moduleName);";
  expect(
    hasChangedExecutableUsage({
      sdks: ["vendor"],
      file: "client.ts",
      baseline: source,
      current: source,
    }),
  ).toBe(true);
});

test.each([
  { type: "image", file: "images.json", name: "quickwit" },
  { type: "constant", file: "version.ts", name: "API_VERSIONS" },
] as const satisfies readonly PinSource[])(
  "$type pin allowances reject executable client and helper edits without SDK imports",
  (source) => {
    const root = mkdtempSync(path.join(tmpdir(), "external-transport-debt-"));
    try {
      const owner = "corpus-index-client.ts";
      const helper = "request.ts";
      const files = new Map([
        ["package.json", "{}"],
        ["bun.lock", '{"packages":{}}'],
        [
          "images.json",
          '[{"name":"quickwit","source":"quickwit@sha256:current"}]',
        ],
        ["version.ts", 'export const API_VERSIONS = ["v2"] as const;'],
        [
          owner,
          'import { body } from "./request"; export const request = () => body;',
        ],
        [helper, 'export const body = "old";'],
        ["replay.test.ts", 'import "./corpus-index-client";'],
      ]);
      for (const [file, text] of files) {
        writeFileSync(path.join(root, file), text);
      }
      const entry = {
        owners: [{ path: owner, role: "primary" }],
        sdks: [],
        pinSources: [source],
        driftTriggers: ["pin-bump"],
        status: "characterised",
        fixtures: [
          {
            path: "replay.test.ts",
            replayFiles: ["replay.test.ts"],
            replay: "fetch-replay",
            metadata: "receipt.json",
            provenance: { type: "authored", kind: "synthetic-from-spec" },
          },
        ],
        uncharacterisedScope: { owners: [], sdks: [] },
      } as const satisfies ExternalContractEntry;
      const pins = readCurrentPins(root, entry);
      writeFileSync(
        path.join(root, "receipt.json"),
        JSON.stringify({
          characterisedAt: Object.fromEntries(
            Object.keys(pins).map((key) => [key, "older"]),
          ),
          coveredOwners: [owner],
          coveredSdks: [],
          fixtureSet: "replay.test.ts",
          provenance: entry.fixtures[0].provenance,
        }),
      );
      const options = {
        root,
        system: "quickwit",
        entry,
        baseline: (file: string) => files.get(file),
        admitted: { ...pinDebt, system: "quickwit", pins },
        now: new Date("2026-10-15T00:00:00.000Z"),
      };
      expect(checkContractEntry(options)).toEqual([]);
      for (const file of [owner, helper]) {
        const original = files.get(file) ?? panic("Missing runtime fixture");
        writeFileSync(
          path.join(root, file),
          `${original}\nexport const addedRequest = "new";`,
        );
        expect(readCurrentPins(root, entry)).toEqual(pins);
        const problems = checkContractEntry(options).join("\n");
        expect(problems).toContain("ExternalContractAllowanceInvalidated");
        expect(problems).toContain("re-characterise quickwit");
        expect(problems).toContain(
          "runtime closure changed or could not be resolved",
        );
        writeFileSync(
          path.join(root, file),
          `// updated comment\n${original}\ntype Request = string;`,
        );
        expect(checkContractEntry(options)).toEqual([]);
        writeFileSync(path.join(root, file), original);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("local runtime closure changes invalidate dated debt", () => {
  const root = "/fixture";
  const owner = "owner.ts";
  const helper = "helper.ts";
  const ownerSource =
    'import sdk from "vendor"; import { requestBuilder } from "./helper"; sdk.send(requestBuilder());';
  const files = new Map([
    [owner, ownerSource],
    [helper, 'export const requestBuilder = () => ({ body: "old" });'],
  ]);
  const options = {
    root,
    owners: [owner],
    sdks: ["vendor"],
    baseline: (file: string) => files.get(file),
    current: (file: string) => files.get(file),
  };

  expect(hasChangedLocalRuntimeClosure(options)).toBe(false);
  expect(
    hasChangedLocalRuntimeClosure({
      ...options,
      current: (file: string) =>
        file === helper
          ? 'export const requestBuilder = () => ({ body: "new" });'
          : files.get(file),
    }),
  ).toBe(true);
  expect(
    hasChangedLocalRuntimeClosure({
      ...options,
      current: (file: string) =>
        file === helper
          ? '// revised comment\nexport const requestBuilder = (): { body: string } => ({ body: "old" });'
          : files.get(file),
    }),
  ).toBe(false);
});

test("added and removed files in a local runtime closure invalidate dated debt", () => {
  const root = "/fixture";
  const owner = "owner.ts";
  const helper = "helper.ts";
  const ownerSource =
    'import sdk from "vendor"; import "./helper"; sdk.send();';
  const files = new Map([
    [owner, ownerSource],
    [helper, "export const value = true;"],
  ]);
  const options = {
    root,
    owners: [owner],
    sdks: ["vendor"],
    baseline: (file: string) => files.get(file),
    current: (file: string) => files.get(file),
  };

  expect(
    hasChangedLocalRuntimeClosure({
      ...options,
      current: (file: string) =>
        file === helper ? undefined : files.get(file),
    }),
  ).toBe(true);
  expect(
    hasChangedLocalRuntimeClosure({
      ...options,
      baseline: (file: string) => {
        if (file === owner) {
          return 'import sdk from "vendor"; sdk.send();';
        }
        if (file === helper) {
          return undefined;
        }
        return files.get(file);
      },
    }),
  ).toBe(true);
});

test("unresolved and non-literal imports in reachable helpers invalidate dated debt", () => {
  const root = "/fixture";
  const owner = "owner.ts";
  const helper = "helper.ts";
  const ownerSource =
    'import sdk from "vendor"; import "./helper"; sdk.send();';
  const files = new Map([
    [owner, ownerSource],
    [helper, "export const value = true;"],
  ]);
  const options = {
    root,
    owners: [owner],
    sdks: ["vendor"],
    baseline: (file: string) => files.get(file),
    current: (file: string) => files.get(file),
  };

  expect(
    hasChangedLocalRuntimeClosure({
      ...options,
      baseline: (file: string) => (file === owner ? ownerSource : undefined),
    }),
  ).toBe(true);
  expect(
    hasChangedLocalRuntimeClosure({
      ...options,
      current: (file: string) =>
        file === owner
          ? 'import sdk from "vendor"; import "./missing"; sdk.send();'
          : files.get(file),
    }),
  ).toBe(true);
  expect(
    hasChangedLocalRuntimeClosure({
      ...options,
      current: (file: string) => {
        if (file === owner) {
          return ownerSource;
        }
        if (file === helper) {
          return 'const moduleName = "./missing"; await import(moduleName);';
        }
        return undefined;
      },
    }),
  ).toBe(true);
});

test("workspace package imports resolve against each snapshot's exports", () => {
  const root = "/fixture";
  const owner = "owner.ts";
  const manifest = "packages/helper/package.json";
  const files = new Map([
    [owner, 'import sdk from "vendor"; import "@stll/helper"; sdk.send();'],
    [
      manifest,
      JSON.stringify({ name: "@stll/helper", exports: "./src/index.ts" }),
    ],
    ["packages/helper/src/index.ts", "export const value = true;"],
    ["packages/helper/src/next.ts", "export const value = true;"],
  ]);
  const options = {
    root,
    owners: [owner],
    sdks: ["vendor"],
    baseline: (file: string) => files.get(file),
    current: (file: string) => files.get(file),
  };

  expect(hasChangedLocalRuntimeClosure(options)).toBe(false);
  expect(
    hasChangedLocalRuntimeClosure({
      ...options,
      current: (file: string) =>
        file === manifest
          ? JSON.stringify({ name: "@stll/helper", exports: "./src/next.ts" })
          : files.get(file),
    }),
  ).toBe(true);
});

test("bookkeeping changes invalidate debt only when reachable from SDK usage", () => {
  const owner = "owner.ts";
  const bookkeeping = "bookkeeping.ts";
  const files = new Map([
    [owner, 'import sdk from "vendor"; sdk.send();'],
    [bookkeeping, 'export const receipt = "old";'],
  ]);
  const options = {
    root: "/fixture",
    owners: [owner, bookkeeping],
    sdks: ["vendor"],
    baseline: (file: string) => files.get(file),
    current: (file: string) =>
      file === bookkeeping ? 'export const receipt = "new";' : files.get(file),
  };
  expect(hasChangedLocalRuntimeClosure(options)).toBe(false);
  files.set(
    owner,
    'import sdk from "vendor"; import { receipt } from "./bookkeeping"; sdk.send(receipt);',
  );
  expect(hasChangedLocalRuntimeClosure(options)).toBe(true);
});

test("unresolved edges fail closed even in owners without known SDK reachability", () => {
  for (const text of [
    'import "./missing";',
    'const name = "vendor"; await import(name);',
  ]) {
    expect(
      hasChangedLocalRuntimeClosure({
        root: "/fixture",
        owners: ["owner.ts"],
        sdks: ["vendor"],
        baseline: () => text,
        current: () => text,
      }),
    ).toBe(true);
  }
});

test("SDK reachability through a local helper includes the entire owner closure", () => {
  const files = new Map([
    ["owner.ts", 'import { send } from "./helper"; send();'],
    [
      "helper.ts",
      'import sdk from "vendor"; export const send = () => sdk.send("old");',
    ],
  ]);
  const options = {
    root: "/fixture",
    owners: ["owner.ts"],
    sdks: ["vendor"],
    baseline: (file: string) => files.get(file),
    current: (file: string) => files.get(file),
  };
  expect(hasChangedLocalRuntimeClosure(options)).toBe(false);
  expect(
    hasChangedLocalRuntimeClosure({
      ...options,
      current: (file: string) =>
        file === "owner.ts"
          ? 'import { send } from "./helper"; send(); send();'
          : files.get(file),
    }),
  ).toBe(true);
});

test.each(["package.json", "new-package.json"])(
  "SDK additions with a pin source in %s require current receipts despite existing debt",
  (newManifest) => {
    const root = mkdtempSync(
      path.join(tmpdir(), "external-contract-addition-"),
    );
    try {
      const owner = "owner.ts";
      const ownerText =
        'import oldSdk from "old-sdk"; import newSdk from "new-sdk"; oldSdk.send(); newSdk.send();';
      const packageText = JSON.stringify({
        catalog: { "old-sdk": "2", "new-sdk": "2" },
      });
      const lockText = JSON.stringify({
        packages: {
          "old-sdk": ["old-sdk@2", "", {}, "sha512:test"],
          "new-sdk": ["new-sdk@2", "", {}, "sha512:test"],
        },
      });
      writeFileSync(path.join(root, "package.json"), packageText);
      if (newManifest !== "package.json") {
        writeFileSync(path.join(root, newManifest), packageText);
      }
      writeFileSync(path.join(root, "bun.lock"), lockText);
      writeFileSync(path.join(root, owner), ownerText);
      writeFileSync(path.join(root, "replay.test.ts"), 'import "./owner";');
      mkdirSync(path.join(root, "fixtures"));
      for (const sdk of ["old-sdk", "new-sdk"]) {
        const directory = path.join(root, "node_modules", sdk);
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          path.join(directory, "package.json"),
          JSON.stringify({ name: sdk, version: "2", exports: "./client.js" }),
        );
        writeFileSync(path.join(directory, "client.js"), "export default {}; ");
      }
      const entry = {
        owners: [{ path: owner, role: "primary" }],
        sdks: ["old-sdk", "new-sdk"],
        pinSources: [
          {
            type: "manifest",
            file: "package.json",
            section: "catalog",
            package: "old-sdk",
          },
          {
            type: "manifest",
            file: newManifest,
            section: "catalog",
            package: "new-sdk",
          },
        ],
        driftTriggers: [],
        status: "characterised",
        fixtures: [
          {
            path: "fixtures",
            replayFiles: ["replay.test.ts"],
            replay: "wire-fake",
            provenance: { type: "authored", kind: "recorded" },
            metadata: "receipt.json",
          },
        ],
        uncharacterisedScope: { owners: [], sdks: [] },
      } as const satisfies ExternalContractEntry;
      const baseFiles = new Map([
        ["package.json", JSON.stringify({ catalog: { "old-sdk": "2" } })],
        [
          "bun.lock",
          JSON.stringify({
            packages: { "old-sdk": ["old-sdk@2", "", {}, "sha512:test"] },
          }),
        ],
        [owner, ownerText],
      ]);
      const existingPins = {
        "package.json#catalog.old-sdk": "2",
        "bun.lock#old-sdk": "old-sdk@2",
      };
      const currentPins = readCurrentPins(root, entry);
      const baseline = (file: string) => baseFiles.get(file);
      expect(readBaselinePins(entry, baseline)).toEqual(existingPins);
      baseFiles.set("package.json", packageText);
      expect(readBaselinePins(entry, baseline)).toEqual(existingPins);
      const options = {
        root,
        system: "example",
        entry,
        baseline,
        admitted: { ...pinDebt, pins: existingPins },
        now: new Date("2026-10-15T00:00:00.000Z"),
      };
      const writeReceipt = (characterisedAt: Record<string, string>) =>
        writeFileSync(
          path.join(root, "receipt.json"),
          JSON.stringify({
            characterisedAt,
            coveredOwners: [owner],
            coveredSdks: entry.sdks,
            fixtureSet: "fixtures",
            provenance: entry.fixtures[0].provenance,
          }),
        );
      const oldReceiptPins = {
        "package.json#catalog.old-sdk": "1",
        "bun.lock#old-sdk": "old-sdk@1",
      };
      writeReceipt({ ...currentPins, ...oldReceiptPins });
      expect(checkContractEntry(options)).toEqual([]);
      expect(
        checkContractEntry({ ...options, baseline: undefined }).join("\n"),
      ).toContain("ExternalContractBaselineUnavailable");
      writeReceipt(oldReceiptPins);
      expect(checkContractEntry(options).join("\n")).toContain(
        "fixture pin missing",
      );
      writeReceipt({
        ...oldReceiptPins,
        [`${newManifest}#catalog.new-sdk`]: "1",
        "bun.lock#new-sdk": "new-sdk@1",
      });
      expect(
        checkContractEntry({
          ...options,
          admitted: { ...pinDebt, pins: currentPins },
        }).join("\n"),
      ).toContain("re-characterise example at 2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("snapshot SDK closures accept native checker options without hiding invalid configuration", () => {
  const files = new Map([
    [
      "owner.ts",
      'import sdk from "vendor"; import { payload } from "request-helper"; sdk.send(payload);',
    ],
    ["helper.ts", 'export const payload = "old";'],
    [
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          checkers: 1,
          paths: { "request-helper": ["./helper.ts"] },
        },
      }),
    ],
  ]);
  const options = {
    root: "/fixture",
    owners: ["owner.ts"],
    sdks: ["vendor"],
    baseline: (file: string) => files.get(file),
    current: (file: string) => files.get(file),
  };
  expect(hasChangedLocalRuntimeClosure(options)).toBe(false);
  expect(
    hasChangedLocalRuntimeClosure({
      ...options,
      current: (file: string) =>
        file === "helper.ts"
          ? 'export const payload = "new";'
          : files.get(file),
    }),
  ).toBe(true);
  for (const invalid of [
    {
      compilerOptions: {
        chekcers: 1,
        paths: { "request-helper": ["./helper.ts"] },
      },
    },
    {
      extends: "./missing-config.json",
      compilerOptions: { paths: { "request-helper": ["./helper.ts"] } },
    },
  ]) {
    expect(
      hasChangedLocalRuntimeClosure({
        ...options,
        current: (file: string) =>
          file === "tsconfig.json" ? JSON.stringify(invalid) : files.get(file),
      }),
    ).toBe(true);
  }
});

test("literal text assets remain in the SDK runtime closure", () => {
  const files = new Map([
    [
      "owner.ts",
      'import sdk from "vendor"; import payload from "./request.html.txt" with { type: "text" }; sdk.send(payload);',
    ],
    ["request.html.txt", "old payload"],
  ]);
  const options = {
    root: "/fixture",
    owners: ["owner.ts"],
    sdks: ["vendor"],
    baseline: (file: string) => files.get(file),
    current: (file: string) => files.get(file),
  };
  expect(hasChangedLocalRuntimeClosure(options)).toBe(false);
  expect(
    hasChangedLocalRuntimeClosure({
      ...options,
      current: (file: string) =>
        file === "request.html.txt" ? "new payload" : files.get(file),
    }),
  ).toBe(true);
  expect(
    hasChangedLocalRuntimeClosure({
      ...options,
      current: (file: string) =>
        file === "request.html.txt" ? undefined : files.get(file),
    }),
  ).toBe(true);
});

test("literal binary assets resolve through relative and snapshot path aliases", () => {
  const files = new Map([
    [
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { paths: { "@assets/*": ["assets/*"] } },
      }),
    ],
    [
      "owner.ts",
      'import sdk from "vendor"; import "@assets/font.ttf" with { type: "file" }; import "./assets/template.docx" with { type: "file" }; sdk.send();',
    ],
    ["assets/font.ttf", "font bytes"],
    ["assets/template.docx", "template bytes"],
  ]);
  const read = (file: string) => files.get(file);
  const options = {
    root: "/fixture",
    owners: ["owner.ts"],
    sdks: ["vendor"],
    baseline: read,
    current: read,
  };
  expect(hasChangedLocalRuntimeClosure(options)).toBe(false);
  for (const asset of ["assets/font.ttf", "assets/template.docx"]) {
    expect(
      hasChangedLocalRuntimeClosure({
        ...options,
        current: (file: string) =>
          file === asset ? "changed bytes" : read(file),
      }),
    ).toBe(true);
    expect(
      hasChangedLocalRuntimeClosure({
        ...options,
        current: (file: string) => (file === asset ? undefined : read(file)),
      }),
    ).toBe(true);
  }
});

test("literal dynamic imports with options compare payload data and keep unchanged debt", () => {
  const files = new Map([
    [
      "owner.ts",
      'import sdk from "vendor"; const payload = await import("./payload.json", { with: { type: "json" } }); sdk.send(payload);',
    ],
    ["payload.json", '{"body":"old"}'],
  ]);
  const read = (file: string) => files.get(file);
  const options = {
    root: "/fixture",
    owners: ["owner.ts"],
    sdks: ["vendor"],
    baseline: read,
    current: read,
  };
  expect(hasChangedLocalRuntimeClosure(options)).toBe(false);
  expect(
    hasChangedLocalRuntimeClosure({
      ...options,
      current: (file: string) =>
        file === "payload.json" ? '{"body":"new"}' : read(file),
    }),
  ).toBe(true);
  expect(
    hasChangedLocalRuntimeClosure({
      ...options,
      current: (file: string) =>
        file === "owner.ts"
          ? 'import sdk from "vendor"; await import(name, { with: { type: "json" } });'
          : read(file),
    }),
  ).toBe(true);
});

test("large runtime and generator data leaves compare blob IDs without reading or charging bytes", () => {
  const files = new Map([
    [
      "owner.ts",
      'import sdk from "vendor"; import "./generated/adapter"; import "./payload.json";',
    ],
    ["generator.ts", 'export const generate = () => "output";'],
  ]);
  let measuredDataBytes = 0;
  const snapshots = (id: string | undefined) =>
    Object.assign(
      (file: string) => {
        if (file === "payload.json") {
          return panic("Data leaf content must not be read");
        }
        return files.get(file);
      },
      {
        blobId: (file: string) => (file === "payload.json" ? id : undefined),
        byteLength: (file: string) => {
          if (file === "payload.json") {
            measuredDataBytes += 1;
            return 64 * 1024 * 1024;
          }
          return files.get(file)?.length;
        },
      },
    );
  const options = {
    root: "/fixture",
    owners: ["owner.ts"],
    sdks: ["vendor"],
    baseline: snapshots("a".repeat(40)),
    current: snapshots("a".repeat(40)),
    registryFiles: [],
    generators: [
      {
        id: "adapter",
        outputKind: "derived",
        outputs: ["generated/adapter.ts"],
        inputs: ["generator.ts", "payload.json"],
        write: ["bun", "generator.ts"],
      },
    ] as const,
  };
  expect(hasChangedLocalRuntimeClosure(options)).toBe(false);
  expect(
    hasChangedLocalRuntimeClosure({
      ...options,
      current: snapshots("b".repeat(40)),
    }),
  ).toBe(true);
  expect(
    hasChangedLocalRuntimeClosure({
      ...options,
      current: snapshots(undefined),
    }),
  ).toBe(true);
  expect(
    readLocalClosure({
      root: options.root,
      read: snapshots(undefined),
      generators: options.generators,
      registryFiles: [],
    })(["owner.ts"]).problems.join("\n"),
  ).toContain("Cannot resolve runtime data blob payload.json");
  expect(measuredDataBytes).toBe(0);
});

test("published packages with workspace-like names stop the local closure", () => {
  const files = new Map([
    [
      "owner.ts",
      'import sdk from "vendor"; import { helper } from "@stll/published-helper"; sdk.send(helper());',
    ],
    [
      "package.json",
      JSON.stringify({ dependencies: { "@stll/published-helper": "1.0.0" } }),
    ],
  ]);
  const options = {
    root: "/fixture",
    owners: ["owner.ts"],
    sdks: ["vendor"],
    baseline: (file: string) => files.get(file),
    current: (file: string) => files.get(file),
  };
  expect(hasChangedLocalRuntimeClosure(options)).toBe(false);
  files.set(
    "package.json",
    JSON.stringify({
      dependencies: { "@stll/published-helper": "workspace:*" },
    }),
  );
  expect(hasChangedLocalRuntimeClosure(options)).toBe(true);
});

test("a main-side helper move already present in both snapshots preserves dated debt", () => {
  const files = new Map([
    [
      "owner.ts",
      'import sdk from "vendor"; import { payload } from "./moved/helper"; sdk.send(payload);',
    ],
    ["moved/helper.ts", 'export const payload = "old";'],
  ]);
  expect(
    hasChangedLocalRuntimeClosure({
      root: "/fixture",
      owners: ["owner.ts"],
      sdks: ["vendor"],
      baseline: (file: string) => files.get(file),
      current: (file: string) => files.get(file),
    }),
  ).toBe(false);
});

test("generated SDK closure leaves compare declared tracked inputs without running a generator", () => {
  const files = new Map([
    [
      "owner.ts",
      'import sdk from "vendor"; import "./generated/adapter"; sdk.send();',
    ],
    ["generator.ts", 'export const generate = () => "output";'],
    ["inputs/payload.json", '{"message":"old"}'],
  ]);
  const read = Object.assign((file: string) => files.get(file), {
    files: [...files.keys()],
  });
  const generators = [
    {
      id: "adapter",
      outputKind: "derived",
      outputs: ["generated/adapter.ts"],
      inputs: ["generator.ts", "inputs/*.json"],
      write: ["bun", "generator.ts"],
    },
  ] as const;
  const options = {
    root: "/fixture",
    owners: ["owner.ts"],
    sdks: ["vendor"],
    baseline: read,
    current: read,
    generators,
    registryFiles: [],
  };
  expect(hasChangedLocalRuntimeClosure(options)).toBe(false);
  expect(
    hasChangedLocalRuntimeClosure({
      ...options,
      current: Object.assign(
        (file: string) =>
          file === "inputs/payload.json"
            ? '{"message":"new"}'
            : files.get(file),
        { files: read.files },
      ),
    }),
  ).toBe(true);
  expect(
    hasChangedLocalRuntimeClosure({
      ...options,
      current: Object.assign(
        (file: string) =>
          file === "generator.ts"
            ? 'export const generate = () => "changed";'
            : files.get(file),
        { files: read.files },
      ),
    }),
  ).toBe(true);
  expect(
    hasChangedLocalRuntimeClosure({
      ...options,
      current: Object.assign(
        (file: string) =>
          file === "generator.ts"
            ? '// comment\nexport const generate = (): string => "output";'
            : files.get(file),
        { files: read.files },
      ),
    }),
  ).toBe(false);
  expect(
    hasChangedLocalRuntimeClosure({
      ...options,
      current: Object.assign((file: string) => files.get(file), {
        files: ["owner.ts", "generator.ts"],
      }),
    }),
  ).toBe(true);
});

test("generator code inputs include imported helper changes while erasing comments and types", () => {
  const files = new Map([
    [
      "owner.ts",
      'import sdk from "vendor"; import "./generated/adapter"; sdk.send();',
    ],
    [
      "generator.ts",
      'import { payload } from "./helper"; export const generate = () => payload;',
    ],
    ["helper.ts", 'export const payload = "old";'],
  ]);
  const read = Object.assign((file: string) => files.get(file), {
    files: [...files.keys()],
  });
  const options = {
    root: "/fixture",
    owners: ["owner.ts"],
    sdks: ["vendor"],
    baseline: read,
    current: read,
    generators: [
      {
        id: "adapter",
        outputKind: "derived",
        outputs: ["generated/adapter.ts"],
        inputs: ["generator.ts"],
        write: ["bun", "generator.ts"],
      },
    ] as const,
    registryFiles: [],
  };
  expect(hasChangedLocalRuntimeClosure(options)).toBe(false);
  for (const [helper, expected] of [
    ['export const payload = "new";', true],
    ['// updated comment\nexport const payload: string = "old";', false],
    ['const load = require; export const payload = load("./hidden");', true],
  ] as const) {
    expect(
      hasChangedLocalRuntimeClosure({
        ...options,
        current: Object.assign(
          (file: string) => (file === "helper.ts" ? helper : files.get(file)),
          { files: read.files },
        ),
      }),
    ).toBe(expected);
  }
});

test("generated imports without a registered generator or declared inputs fail closed with a named reason", () => {
  const files = new Map([
    ["owner.ts", 'import "./generated/unregistered";'],
    [
      "generated/unregistered.ts",
      "// GENERATED by a generator.\nexport const value = true;",
    ],
  ]);
  const read = Object.assign((file: string) => files.get(file), {
    files: [...files.keys()],
  });
  const options = { root: "/fixture", read, generators: [], registryFiles: [] };
  expect(
    createLocalRuntimeClosureReader(options)(["owner.ts"]).problems,
  ).toContain(
    "Generated module generated/unregistered.ts has no registered generator",
  );
  expect(
    hasChangedLocalRuntimeClosure({
      ...options,
      owners: ["owner.ts"],
      sdks: ["vendor"],
      baseline: read,
      current: read,
    }),
  ).toBe(true);
  const generators = [
    {
      id: "unregistered",
      outputKind: "derived",
      outputs: ["generated/unregistered.ts"],
      inputs: [],
      write: ["bun", "generator.ts"],
    },
  ] as const;
  expect(
    createLocalRuntimeClosureReader({ ...options, generators })(["owner.ts"])
      .problems,
  ).toContain(
    "Generated module generated/unregistered.ts has no unique generator with declared inputs",
  );
});

test("private package imports stop at external assets and track their alias manifest", () => {
  const files = new Map([
    [
      "owner.ts",
      'import sdk from "vendor"; import asset from "#runtime.wasm" with { type: "file" }; sdk.send(asset);',
    ],
    [
      "package.json",
      JSON.stringify({
        imports: { "#runtime.wasm": "@stll/published-runtime/wasm" },
        dependencies: { "@stll/published-runtime": "1.0.0" },
      }),
    ],
  ]);
  const options = {
    root: "/fixture",
    owners: ["owner.ts"],
    sdks: ["vendor"],
    baseline: (file: string) => files.get(file),
    current: (file: string) => files.get(file),
  };
  expect(hasChangedLocalRuntimeClosure(options)).toBe(false);
  expect(
    hasChangedLocalRuntimeClosure({
      ...options,
      current: (file: string) =>
        file === "package.json"
          ? JSON.stringify({
              imports: {
                "#runtime.wasm": "@stll/published-runtime/changed-wasm",
              },
              dependencies: { "@stll/published-runtime": "1.0.0" },
            })
          : files.get(file),
    }),
  ).toBe(true);
});

test("generated data inputs compare blob identities despite identical decoded text", () => {
  const files = new Map([
    [
      "owner.ts",
      'import sdk from "vendor"; import "./generated/adapter"; sdk.send();',
    ],
    ["generator.ts", 'export const generate = () => "output";'],
    ["input.bin", "\uFFFD"],
  ]);
  const read = (bytes: Uint8Array) =>
    Object.assign((file: string) => files.get(file), {
      files: [...files.keys()],
      blobId: (file: string) => {
        const text = files.get(file);
        if (text === undefined) {
          return undefined;
        }
        return sha256Hex(file === "input.bin" ? bytes : text);
      },
    });
  const options = {
    root: "/fixture",
    owners: ["owner.ts"],
    sdks: ["vendor"],
    baseline: read(new Uint8Array([255])),
    current: read(new Uint8Array([254])),
    generators: [
      {
        id: "adapter",
        outputKind: "derived",
        outputs: ["generated/adapter.ts"],
        inputs: ["generator.ts", "input.bin"],
        write: ["bun", "generator.ts"],
      },
    ] as const,
    registryFiles: [],
  };
  expect(hasChangedLocalRuntimeClosure(options)).toBe(true);
});

test("an uncommitted tracked data edit invalidates a pin allowance", () => {
  const root = mkdtempSync(path.join(tmpdir(), "external-contract-worktree-"));
  const runGit = (arguments_: readonly string[]) => {
    const result = Bun.spawnSync(["git", ...arguments_], { cwd: root });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  try {
    runGit(["init", "-b", "main"]);
    runGit(["config", "user.name", "Contract Test"]);
    runGit(["config", "user.email", "contract@example.invalid"]);
    writeFileSync(
      path.join(root, "owner.ts"),
      'import sdk from "vendor"; import "./generated/adapter"; sdk.send();',
    );
    writeFileSync(
      path.join(root, "generator.ts"),
      'export const generate = () => "output";',
    );
    writeFileSync(path.join(root, "input.bin"), new Uint8Array([255]));
    runGit(["add", "."]);
    runGit(["commit", "-m", "baseline"]);
    const baseline = createGitBaselineReader({ root, base: "HEAD" });

    writeFileSync(path.join(root, "input.bin"), new Uint8Array([254]));
    const identities = readGitWorkingTreeBlobIds(root);
    const current = Object.assign(
      (file: string) => {
        const absolute = path.join(root, file);
        return file.endsWith(".bin") || !existsSync(absolute)
          ? undefined
          : readFileSync(absolute, "utf-8");
      },
      {
        files: [...identities.keys()],
        blobId: (file: string) => identities.get(file),
        byteLength: (file: string) =>
          readFileSync(path.join(root, file)).byteLength,
      },
    );
    expect(current.blobId("input.bin")).not.toBe(baseline.blobId("input.bin"));
    const usageChanged = compareLocalRuntimeClosure({
      scope: "sdk-reachable",
      root,
      owners: ["owner.ts"],
      sdks: ["vendor"],
      baseline,
      current,
      registryFiles: [],
      generators: [
        {
          id: "adapter",
          outputKind: "derived",
          outputs: ["generated/adapter.ts"],
          inputs: ["generator.ts", "input.bin"],
          write: ["bun", "generator.ts"],
        },
      ],
    });
    expect(usageChanged).toBe(true);
    expect(
      admittedPinDrift({
        current: { sdk: "2" },
        baseline: { sdk: "2" },
        allowance: pinDebt,
        now: new Date("2026-10-15T00:00:00.000Z"),
        usageChanged,
      }),
    ).toEqual({});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a newly staged generator input invalidates a pin allowance", () => {
  const root = mkdtempSync(path.join(tmpdir(), "external-contract-worktree-"));
  const runGit = (arguments_: readonly string[]) => {
    const result = Bun.spawnSync(["git", ...arguments_], { cwd: root });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  try {
    runGit(["init", "-b", "main"]);
    runGit(["config", "user.name", "Contract Test"]);
    runGit(["config", "user.email", "contract@example.invalid"]);
    writeFileSync(
      path.join(root, "owner.ts"),
      'import sdk from "vendor"; import "./generated/adapter"; sdk.send();',
    );
    writeFileSync(path.join(root, "generator.ts"), "export const value = 1;");
    mkdirSync(path.join(root, "inputs"));
    runGit(["add", "."]);
    runGit(["commit", "-m", "baseline"]);
    const baseline = createGitBaselineReader({ root, base: "HEAD" });

    writeFileSync(path.join(root, "inputs/new.json"), '{"value":2}');
    runGit(["add", "inputs/new.json"]);
    const identities = readGitWorkingTreeBlobIds(root);
    const current = Object.assign(
      (file: string) => {
        const absolute = path.join(root, file);
        return existsSync(absolute)
          ? readFileSync(absolute, "utf-8")
          : undefined;
      },
      {
        files: [...identities.keys()],
        blobId: (file: string) => identities.get(file),
        byteLength: (file: string) =>
          readFileSync(path.join(root, file)).byteLength,
      },
    );
    expect(current.files).toContain("inputs/new.json");
    const usageChanged = compareLocalRuntimeClosure({
      scope: "sdk-reachable",
      root,
      owners: ["owner.ts"],
      sdks: ["vendor"],
      baseline,
      current,
      registryFiles: [],
      generators: [
        {
          id: "adapter",
          outputKind: "derived",
          outputs: ["generated/adapter.ts"],
          inputs: ["generator.ts", "inputs/*.json"],
          write: ["bun", "generator.ts"],
        },
      ],
    });
    expect(usageChanged).toBe(true);
    expect(
      admittedPinDrift({
        current: { sdk: "2" },
        baseline: { sdk: "2" },
        allowance: pinDebt,
        now: new Date("2026-10-15T00:00:00.000Z"),
        usageChanged,
      }),
    ).toEqual({});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("private imports expose pinned SDK reachability to the changed usage guard", () => {
  const files = new Map([
    ["owner.ts", 'import sdk from "#sdk"; sdk.send("old");'],
    [
      "package.json",
      JSON.stringify({
        imports: { "#sdk": "vendor" },
        dependencies: { vendor: "1.0.0" },
      }),
    ],
  ]);
  const options = {
    root: "/fixture",
    owners: ["owner.ts"],
    sdks: ["vendor"],
    baseline: (file: string) => files.get(file),
    current: (file: string) => files.get(file),
  };
  expect(hasChangedLocalRuntimeClosure(options)).toBe(false);
  expect(
    hasChangedLocalRuntimeClosure({
      ...options,
      current: (file: string) =>
        file === "owner.ts"
          ? 'import sdk from "#sdk"; sdk.send("new");'
          : files.get(file),
    }),
  ).toBe(true);
});

test("private import maps with unproved branches cannot hide pinned SDK reachability", () => {
  const files = new Map([
    ["owner.ts", 'import sdk from "#sdk"; sdk.send("old");'],
    ["fallback.ts", "export default { send() {} };"],
    [
      "package.json",
      JSON.stringify({
        imports: { "#sdk": { bun: "vendor", default: "./fallback.ts" } },
        dependencies: { vendor: "1.0.0" },
      }),
    ],
  ]);
  const read = (file: string) => files.get(file);
  expect(
    createLocalRuntimeClosureReader({ root: "/fixture", read })(["owner.ts"])
      .problems,
  ).toContain("Cannot prove literal private import #sdk from package.json");
  expect(
    hasChangedLocalRuntimeClosure({
      root: "/fixture",
      owners: ["owner.ts"],
      sdks: ["vendor"],
      baseline: read,
      current: read,
    }),
  ).toBe(true);
});
for (const loader of [
  'const load = require; load("./helper");',
  "consume(require);",
  'const load = module.require; load("./helper");',
  'const load = module["require"]; load("./helper");',
  'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); load("./helper");',
  'import { createRequire as factory } from "node:module"; const load = factory(import.meta.url); load("./helper");',
]) {
  test(`indirect loader invalidates closure: ${loader}`, () => {
    const owner = `import sdk from "vendor"; ${loader}`;
    const sources = new Map([
      ["owner.ts", owner],
      ["helper.ts", 'export const body = "old";'],
    ]);
    const baseline = (file: string) => sources.get(file);
    const current = (file: string) =>
      file === "helper.ts" ? 'export const body = "new";' : sources.get(file);
    const options = {
      root: "/fixture",
      owners: ["owner.ts"],
      sdks: ["vendor"],
      baseline,
      current,
    };
    expect(hasChangedLocalRuntimeClosure(options)).toBe(true);
    expect(
      hasChangedLocalRuntimeClosure({ ...options, current: baseline }),
    ).toBe(true);
    const closure = createLocalRuntimeClosureReader({
      root: "/fixture",
      read: baseline,
    })(["owner.ts"]);
    expect(
      closure.problems.some((problem) =>
        problem.includes("Indirect CommonJS loader use"),
      ),
    ).toBe(true);
  });
}
for (const loader of [
  'require("./helper");',
  'module.require("./helper");',
  'import { createRequire } from "node:module"; createRequire(import.meta.url)("./helper");',
]) {
  test(`direct literal loader keeps unchanged closure: ${loader}`, () => {
    const owner = `import sdk from "vendor"; ${loader}`;
    const sources = new Map([
      ["owner.ts", owner],
      ["helper.ts", 'export const body = "old";'],
    ]);
    const baseline = (file: string) => sources.get(file);
    const options = {
      root: "/fixture",
      owners: ["owner.ts"],
      sdks: ["vendor"],
      baseline,
      current: baseline,
    };
    expect(hasChangedLocalRuntimeClosure(options)).toBe(false);
    expect(
      hasChangedLocalRuntimeClosure({
        ...options,
        current: (file: string) =>
          file === "helper.ts" ? 'export const body = "new";' : baseline(file),
      }),
    ).toBe(true);
  });
}
