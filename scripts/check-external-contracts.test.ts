import { panic } from "better-result";
import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import { IN_PROCESS_DEPENDENCIES } from "../packages/external-contracts/src/dependency-dispositions";
import {
  findTotalityProblems,
  findVersionDrift,
} from "../packages/external-contracts/src/guard";
import { EXTERNAL_CONTRACTS } from "../packages/external-contracts/src/registry";
import type { ExternalContractEntry } from "../packages/external-contracts/src/types";
import {
  admittedPinDrift,
  checkContractEntry,
  readBaselinePins,
  hasChangedExecutableUsage,
  hasChangedLocalRuntimeClosure,
  REMOVED_PIN,
  checkExternalContracts,
  findDependencyCatalogProblems,
  findShrinkOnlyGrowth,
  inProcessFromSource,
  lockKeyPackageName,
  uncharacterisedScopeFromSource,
  readDirectDependencies,
  readCurrentPins,
  readExternalSdks,
  readPin,
  uncharacterisedFromSource,
} from "./check-external-contracts";
import {
  OUTBOUND_TRANSPORT_CENSUS,
  type OutboundTransportCensusEntry,
} from "./outbound-transport-census";

const ROOT = path.resolve(import.meta.dir, "..");
const directDependencies = readDirectDependencies(ROOT);
const plantedOwner = {
  path: "apps/api/src/lib/example-unregistered-client.ts",
  class: "third-party",
  reason: "Sends requests to an example service.",
  transports: ["global:fetch"],
} as const satisfies OutboundTransportCensusEntry;

test("the real outbound census and SDK manifests have total offline coverage", () => {
  expect(checkExternalContracts(ROOT)).toEqual([]);
  expect(
    checkExternalContracts(ROOT, {
      census: [...OUTBOUND_TRANSPORT_CENSUS, plantedOwner],
    }).join("\n"),
  ).toContain(`owner ${plantedOwner.path} maps to 0`);
  expect(
    checkExternalContracts(ROOT, {
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
}, 30_000);

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
  expect(checkExternalContracts(ROOT, { registry })).toEqual([
    "The legal-publishers contract must be characterised.",
  ]);
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
    const problems = checkExternalContracts(ROOT, { registry });
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
    expect(checkExternalContracts(ROOT, { registry }).join("\n")).toContain(
      `owner claim ${sharedOwner} is not runtime-reachable`,
    );
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
      checkExternalContracts(ROOT, { registry: refreshedRegistry }),
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
    const problems = checkExternalContracts(ROOT, { registry });
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
