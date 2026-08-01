import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { findUnappliedMigrations } from "./migration-history";

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
        "4757efe9484615eff7bcba9c34687be4aa9b28e07a71137a3638a3072d8a6d3d",
      ],
      [
        "20260603120000_case_law_public_slugs",
        "0d7608766b5bbec1031a31e8a004fc093124596b0cbf4446bd4269ffc834a90b",
      ],
      [
        "20260605143000_workflow_pending_fields_index",
        "0088003d298f869017cf4047a74692a9ddefa4bc246aa6c25ca950ebeb29f918",
      ],
      [
        "20260701160000_property_playbook_definition_id",
        "423af8ce20ec27fa4895b37e3caf64f3470e1ebaa92da58cee04ea5c3dc9085e",
      ],
      [
        "20260703233000_account_credential_singleton",
        "ffd1598dc3a56f44095b549438313351e4bfb467b0fdb83c1def5a6d55f74583",
      ],
      [
        "20260707120000_property_role",
        "033466ccb60b0baa4ad4bbd6b8b0f4e116531b4061353ca0b7069178aebfde02",
      ],
      [
        "20260717170000_report_export_notifications",
        "11856277db1674f04ecf66d39df8f81242f4347af15d60cf2270ee1e3910a317",
      ],
      [
        "20260719172000_user_created_at_index",
        "d75842b57e1ba5f734b2dea9926c76da9fca178d41fafe8005f144cdc4960eee",
      ],
      [
        "20260720140000_machine_api_keys_org_index",
        "c9c7b5d968fe2efa54ef017592d43bb640688ebd6f56b957aca27b45b1412468",
      ],
      [
        "20260731130000_decision_source_document_id",
        "f0dc5e37d764febdad8eba0bc36506c048d22f182f5e0423fd48ad6a26d29a48",
      ],
    ] as const;

    for (const [name, priorHash] of supportedHistories) {
      expect(
        findUnappliedMigrations({
          appliedHashes: new Set([priorHash]),
          localMigrations: [{ hash: "current-hash", name }],
        }),
      ).toEqual([]);
    }
  });
});
