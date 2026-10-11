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

import {
  findTotalityProblems,
  findVersionDrift,
} from "../packages/external-contracts/src/guard";
import { EXTERNAL_CONTRACTS } from "../packages/external-contracts/src/registry";
import {
  checkExternalContracts,
  isExternalSdk,
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
});

test("SDK discovery uses the transport definition and catches SDK-shaped additions", () => {
  for (const sdk of [
    "@aws-sdk/client-new",
    "@tanstack/ai-openai",
    "better-auth",
    "@better-auth/core",
    "@example/sdk",
  ]) {
    expect(isExternalSdk(sdk)).toBe(true);
  }
  for (const library of ["typescript", "valibot", "react"]) {
    expect(isExternalSdk(library)).toBe(false);
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
