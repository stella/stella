import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import nodePath from "node:path";

import { propertyConfig } from "@stll/property-testing";

import {
  assertMigrationHistory,
  findUnappliedMigrations,
} from "./migration-history";

const hexadecimalCharacter = fc.constantFrom(..."0123456789abcdef".split(""));
const migrationHash = fc.string({
  unit: hexadecimalCharacter,
  minLength: 64,
  maxLength: 64,
});
const localMigrations = fc.uniqueArray(
  fc.record({
    hash: migrationHash,
    name: fc.uuid(),
  }),
  { minLength: 1, selector: ({ hash }) => hash },
);

const migrationHistory = localMigrations.chain((local) =>
  fc
    .tuple(
      fc.array(fc.boolean(), {
        minLength: local.length,
        maxLength: local.length,
      }),
      fc.array(fc.uuid(), { maxLength: 10 }),
    )
    .map(([isApplied, unrelatedHashes]) => ({
      appliedHashes: new Set([
        ...local.filter((_, index) => isApplied[index]).map(({ hash }) => hash),
        ...unrelatedHashes.map((hash) => `unrelated-${hash}`),
      ]),
      expectedUnapplied: local.filter((_, index) => !isApplied[index]),
      local,
    })),
);

describe("migration history invariant", () => {
  test("reports exactly the bundled hashes absent from any applied history", () => {
    fc.assert(
      fc.property(
        migrationHistory,
        ({ appliedHashes, expectedUnapplied, local }) => {
          expect(
            findUnappliedMigrations({
              appliedHashes,
              localMigrations: local,
            }),
          ).toEqual(expectedUnapplied);
        },
      ),
      propertyConfig(),
    );
  });

  test("accepts every supported predecessor hash", () => {
    const supportedHistories = [
      [
        "20260603120000_case_law_public_slugs",
        "c1ba2ed2049dd11aeab770ae4681e6b47d924bdbbc2ea480d3d0035199e4ab28",
        "4757efe9484615eff7bcba9c34687be4aa9b28e07a71137a3638a3072d8a6d3d",
      ],
      [
        "20260603120000_case_law_public_slugs",
        "c1ba2ed2049dd11aeab770ae4681e6b47d924bdbbc2ea480d3d0035199e4ab28",
        "0d7608766b5bbec1031a31e8a004fc093124596b0cbf4446bd4269ffc834a90b",
      ],
      [
        "20260605143000_workflow_pending_fields_index",
        "6b0a292d42e172b87ce3bbbf7bfdc108acc2f2f9f0427a32b643b763cb75b447",
        "0088003d298f869017cf4047a74692a9ddefa4bc246aa6c25ca950ebeb29f918",
      ],
      [
        "20260701160000_property_playbook_definition_id",
        "3877a28437845ea1714a41bf2b8c22206ce6f8af363f40a9361b04f38c486c04",
        "423af8ce20ec27fa4895b37e3caf64f3470e1ebaa92da58cee04ea5c3dc9085e",
      ],
      [
        "20260703233000_account_credential_singleton",
        "988b8729f253ee11187aeb8e80ef915c98c7f384e6bffb78ce6201a66b72bfb6",
        "ffd1598dc3a56f44095b549438313351e4bfb467b0fdb83c1def5a6d55f74583",
      ],
      [
        "20260707120000_property_role",
        "8d47e05862c978c9c7176c2e406e00eb5fc3e73e5f80edda28e7a37320856d93",
        "033466ccb60b0baa4ad4bbd6b8b0f4e116531b4061353ca0b7069178aebfde02",
      ],
      [
        "20260717170000_report_export_notifications",
        "094bed35cbea00fc194dc2c2351c9034c55e67b6a6fb808b82cf008345566c3a",
        "11856277db1674f04ecf66d39df8f81242f4347af15d60cf2270ee1e3910a317",
      ],
      [
        "20260719172000_user_created_at_index",
        "cd765faf1da8f1da04146b4ca2736bd739a936f3b3b183b8b2448609a4b18447",
        "d75842b57e1ba5f734b2dea9926c76da9fca178d41fafe8005f144cdc4960eee",
      ],
      [
        "20260720140000_machine_api_keys_org_index",
        "f8714547100e32110a4cd266fb7836c76d6668c23c6223fe718bb5beb36469d3",
        "c9c7b5d968fe2efa54ef017592d43bb640688ebd6f56b957aca27b45b1412468",
      ],
      [
        "20260731130000_decision_source_document_id",
        "85bdb5023fe1126f39e04aad8e7fd3969e2fce28b7d69096cad1a668b8dc45fc",
        "f0dc5e37d764febdad8eba0bc36506c048d22f182f5e0423fd48ad6a26d29a48",
      ],
    ] as const;

    for (const [name, currentHash, priorHash] of supportedHistories) {
      expect(
        findUnappliedMigrations({
          appliedHashes: new Set([priorHash]),
          localMigrations: [{ hash: currentHash, name }],
        }),
      ).toEqual([]);
      expect(
        findUnappliedMigrations({
          appliedHashes: new Set([priorHash]),
          localMigrations: [{ hash: `modified-${currentHash}`, name }],
        }),
      ).toEqual([{ hash: `modified-${currentHash}`, name }]);
    }
  });

  test("reports the intended error when the migrations directory is absent", async () => {
    await expect(
      assertMigrationHistory({
        context: "migrate",
        migrationsDir: nodePath.join(import.meta.dir, "missing-migrations"),
        queryAppliedHashes: async () => new Set(),
        remedy: "No remedy.",
      }),
    ).rejects.toThrow("No migration files");
  });
});
