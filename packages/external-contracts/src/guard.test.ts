import { expect, test } from "bun:test";

import {
  findDependencyProblems,
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

test("drift diagnostics retain the reason a dated pin allowance was not applied", () => {
  for (const reason of [
    "pin has no dated allowance",
    "dated allowance expired",
    "merge-base pin differs from the exact dated allowance",
    "runtime closure changed or could not be resolved",
  ]) {
    expect(
      findVersionDrift({
        system: "example",
        fixture: "receipt.json",
        current: { "bun.lock#sdk": "sdk@2" },
        characterisedAt: { "bun.lock#sdk": "sdk@1" },
        driftReasons: { "bun.lock#sdk": reason },
      }).join("\n"),
    ).toContain(`Allowance not applied: ${reason}.`);
  }
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
    findDependencyProblems({
      registry,
      packages: ["@example/sdk", "parser", "new-vendor-client"],
      inProcess: { parser: "Parses local text." },
    }).join("\n"),
  ).toContain("Dependency new-vendor-client: classify it");
  expect(
    findDependencyProblems({
      registry,
      packages: ["@example/sdk", "parser"],
      inProcess: { parser: "Parses local text." },
    }),
  ).toEqual([]);
  expect(
    findDependencyProblems({
      registry,
      packages: ["@example/sdk"],
      inProcess: { "@example/sdk": "Incorrect duplicate." },
    }).join("\n"),
  ).toContain("exactly one place");
});

test("in-process dependency classifications require a non-empty reason and a unique assignment", () => {
  expect(
    findDependencyProblems({
      registry,
      packages: ["@example/sdk", "parser"],
      inProcess: { parser: "  " },
    }).join("\n"),
  ).toContain(
    "parser: non-external dependency classification requires a reason.",
  );
  expect(
    findDependencyProblems({
      registry,
      packages: ["@example/sdk", "parser"],
      inProcess: { "@example/sdk": "Parser implementation." },
    }).join("\n"),
  ).toContain("Dependency @example/sdk: classify it");
});
