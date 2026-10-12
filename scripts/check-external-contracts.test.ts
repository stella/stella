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

import { IN_PROCESS_DEPENDENCIES } from "../packages/external-contracts/src/dependency-dispositions";
import {
  findTotalityProblems,
  findVersionDrift,
} from "../packages/external-contracts/src/guard";
import { EXTERNAL_CONTRACTS } from "../packages/external-contracts/src/registry";
import type { ExternalContractEntry } from "../packages/external-contracts/src/types";
import {
  checkExternalContracts,
  findDependencyCatalogProblems,
  findShrinkOnlyGrowth,
  inProcessFromSource,
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
        fixtures: [{ ...fixture, metadata: path.relative(ROOT, receiptPath) }],
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
              path.relative(ROOT, replayPath),
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
            metadata: path.relative(ROOT, receiptPath),
            replayFiles: [path.relative(ROOT, replayPath)],
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
