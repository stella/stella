import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import nodePath from "node:path";

import { propertyConfig } from "@stll/property-testing";

import {
  assertMigrationHistory,
  findUnappliedMigrations,
} from "./migration-history";

const MIGRATIONS_DIR = nodePath.resolve(import.meta.dir, "../../../drizzle");
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

  test("accepts every supported predecessor only for its exact current file", async () => {
    const supportedHistories = [
      [
        "20260603120000_case_law_public_slugs",
        "6b7745706b35e0bba31829f9c5262794c7ed4f33455679f28fd998c37eb1718c",
        "4757efe9484615eff7bcba9c34687be4aa9b28e07a71137a3638a3072d8a6d3d",
      ],
      [
        "20260603120000_case_law_public_slugs",
        "6b7745706b35e0bba31829f9c5262794c7ed4f33455679f28fd998c37eb1718c",
        "0d7608766b5bbec1031a31e8a004fc093124596b0cbf4446bd4269ffc834a90b",
      ],
      [
        "20260605143000_workflow_pending_fields_index",
        "00e0820a64f6d5888c79ab9fcd611b599e6622bbc1dc8f4ad668c894af1a41d0",
        "0088003d298f869017cf4047a74692a9ddefa4bc246aa6c25ca950ebeb29f918",
      ],
      [
        "20260629123000_arabic_normalize_function",
        "2efd4a25545a7a4aea7957fccae54994b4037d1963d6c4f479797500f6b79bf4",
        "36ccbd00b7e98f6489d4a493ff61eba96eec145b38ef684045ae408fe88521ce",
      ],
      [
        "20260701160000_property_playbook_definition_id",
        "f5e8604a73353044e3164bc67cb1e6c13936e61639a4190f809df5cc60b44f15",
        "423af8ce20ec27fa4895b37e3caf64f3470e1ebaa92da58cee04ea5c3dc9085e",
      ],
      [
        "20260703233000_account_credential_singleton",
        "9de5d6af3b0acd569ebffa1452e7e441939a1afafb9c6bc59bd461e87e1586bc",
        "ffd1598dc3a56f44095b549438313351e4bfb467b0fdb83c1def5a6d55f74583",
      ],
      [
        "20260707120000_property_role",
        "a3e5b0faa0bf5fc1249848c25707c589d00a5ef1a969efcd6fa313f483030c54",
        "033466ccb60b0baa4ad4bbd6b8b0f4e116531b4061353ca0b7069178aebfde02",
      ],
      [
        "20260717110000_usage_event_idempotency",
        "c769f5c5257528acb310673a276549138a2e44006eeed8dc10beb4153a54cddb",
        "dd0acd610eb979875428ca7778d97cce4baf33b4332479434f66e68c729b2433",
      ],
      [
        "20260717170000_report_export_notifications",
        "8aa876b20155b73a71d3d610210412f0a532dca61ee56f89446540e6eee3809e",
        "11856277db1674f04ecf66d39df8f81242f4347af15d60cf2270ee1e3910a317",
      ],
      [
        "20260719172000_user_created_at_index",
        "60e691372d1eaff6bab6009ed2bc88fff625836b50253203e065c125accdf164",
        "d75842b57e1ba5f734b2dea9926c76da9fca178d41fafe8005f144cdc4960eee",
      ],
      [
        "20260720140000_machine_api_keys_org_index",
        "cc793baee2e7e5c0637cc0f0edbc8cff44706119e7fdd88629d17246857b308f",
        "c9c7b5d968fe2efa54ef017592d43bb640688ebd6f56b957aca27b45b1412468",
      ],
      [
        "20260731130000_decision_source_document_id",
        "15d92f17395b90ef96815823e22b7928cdeaa5ee39021428b7268ffcf0fe4b84",
        "f0dc5e37d764febdad8eba0bc36506c048d22f182f5e0423fd48ad6a26d29a48",
      ],
    ] as const;

    await Promise.all(
      supportedHistories.map(async ([name, currentHash, priorHash]) => {
        const actualHash = new Bun.CryptoHasher("sha256")
          .update(
            await Bun.file(
              nodePath.join(MIGRATIONS_DIR, name, "migration.sql"),
            ).bytes(),
          )
          .digest("hex");
        expect(actualHash).toBe(currentHash);
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
      }),
    );
  });

  test("reports the intended error when the migrations directory is absent", async () => {
    const rejection: unknown = await assertMigrationHistory({
      context: "migrate",
      migrationsDir: nodePath.join(import.meta.dir, "missing-migrations"),
      queryAppliedHashes: async () => new Set(),
      remedy: "No remedy.",
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).toMatchObject({
      message: expect.stringContaining("No migration files"),
    });
  });
});
