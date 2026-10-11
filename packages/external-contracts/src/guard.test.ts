import { expect, test } from "bun:test";

import {
  findCatalogProblems,
  findCoverageDrift,
  findTotalityProblems,
  findUncharacterisedGrowth,
  findVersionDrift,
} from "./guard";
import { EXTERNAL_CONTRACTS } from "./registry";
import type { ExternalContractEntry } from "./types";

const registry = {
  example: {
    owners: [{ path: "example/client.ts", role: "primary" }],
    sdks: ["@example/sdk"],
    pinSources: [],
    driftTriggers: ["pin-bump"],
    status: "uncharacterised",
    reason: "No replay corpus enrolled.",
  },
} as const satisfies Record<string, ExternalContractEntry>;

test("every enrolled owner and SDK resolves to one entry", () => {
  expect(
    findTotalityProblems({
      registry: EXTERNAL_CONTRACTS,
      owners: Object.values(EXTERNAL_CONTRACTS).flatMap(({ owners }) =>
        owners.filter(({ role }) => role === "primary").map(({ path }) => path),
      ),
      sdks: Object.values(EXTERNAL_CONTRACTS).flatMap(({ sdks }) => sdks),
    }),
  ).toEqual([]);
});

test("a planted owner or SDK cannot pass without registration", () => {
  const owners = ["example/client.ts", "example/new-client.ts"];
  const sdks = ["@example/sdk", "@new/sdk"];
  const problems = findTotalityProblems({ registry, owners, sdks });
  expect(problems).toHaveLength(2);
  expect(problems.join("\n")).toContain(
    "owner example/new-client.ts maps to 0",
  );
  expect(problems.join("\n")).toContain("SDK @new/sdk maps to 0");
  expect(problems.join("\n")).toContain("register it in exactly one");
});

test("duplicate owner and SDK assignments fail instead of choosing a default", () => {
  expect(
    findTotalityProblems({
      registry: { ...registry, duplicate: registry.example },
      owners: registry.example.owners.map(({ path }) => path),
      sdks: registry.example.sdks,
    }),
  ).toHaveLength(2);
});

test("every changed or missing fixture pin requires re-characterisation", () => {
  for (const [pin, version] of Object.entries({
    catalog: "2.0.0",
    image: "sha256:new",
    api: "v2",
    lock: "sdk@2",
    patch: "new-hash",
  })) {
    expect(
      findVersionDrift({
        system: "example",
        fixture: "example.source.json",
        current: { [pin]: version },
        characterisedAt: { [pin]: "old" },
      }),
    ).toEqual([
      `example.source.json: re-characterise example at ${version} (${pin}; fixture pin old).`,
    ]);
    expect(
      findVersionDrift({
        system: "example",
        fixture: "example.source.json",
        current: { [pin]: version },
        characterisedAt: {},
      }).join("\n"),
    ).toContain(`re-characterise example at ${version}`);
    expect(
      findVersionDrift({
        system: "example",
        fixture: "example.source.json",
        current: { [pin]: version },
        characterisedAt: { [pin]: version },
      }),
    ).toEqual([]);
  }
});

test("unused pins fail and uncovered contracts only shrink", () => {
  expect(
    findVersionDrift({
      system: "example",
      fixture: "fixture",
      current: {},
      characterisedAt: { removed: "1" },
    }).join("\n"),
  ).toContain("unused pin removed");
  expect(findUncharacterisedGrowth(["old"], ["old", "covered"])).toEqual([]);
  expect(
    findUncharacterisedGrowth(["old", "new"], ["old"]).join("\n"),
  ).toContain("new: uncharacterised contracts only shrink");
});

test("a new catalog dependency must be classified even when its name does not identify an SDK", () => {
  expect(
    findCatalogProblems({
      registry,
      packages: ["@example/sdk", "parser", "new-vendor-client"],
      inProcess: { parser: "Parses local text." },
    }).join("\n"),
  ).toContain("Catalog package new-vendor-client: classify it");
  expect(
    findCatalogProblems({
      registry,
      packages: ["@example/sdk", "parser"],
      inProcess: { parser: "Parses local text." },
    }),
  ).toEqual([]);
  expect(
    findCatalogProblems({
      registry,
      packages: ["@example/sdk"],
      inProcess: { "@example/sdk": "Incorrect duplicate." },
    }).join("\n"),
  ).toContain("exactly one place");
});

test("new owner and SDK scope cannot inherit an existing fixture receipt", () => {
  const receipt = {
    system: "example",
    fixture: "example.source.json",
    owners: ["old.ts"],
    sdks: ["old-sdk"],
    coveredOwners: ["old.ts"],
    coveredSdks: ["old-sdk"],
  };
  expect(findCoverageDrift(receipt)).toEqual([]);
  expect(
    findCoverageDrift({ ...receipt, owners: ["old.ts", "new.ts"] }).join("\n"),
  ).toContain("re-characterise example");
  expect(
    findCoverageDrift({ ...receipt, sdks: ["old-sdk", "new-sdk"] }).join("\n"),
  ).toContain("re-characterise example");
  expect(
    findCoverageDrift({
      ...receipt,
      owners: ["old.ts", "new.ts"],
      coveredOwners: ["old.ts", "old.ts"],
    }).join("\n"),
  ).toContain("different owners or SDKs");
});
