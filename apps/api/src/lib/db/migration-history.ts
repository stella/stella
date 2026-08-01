import { panic } from "better-result";
import { existsSync, readdirSync } from "node:fs";
import nodePath from "node:path";

// Migrations intentionally rewritten after they shipped in a release. A
// database that applied the earlier version recorded its hash, and the
// migrator never re-runs an already-applied folder, so the rewritten hash is
// never stored. Accept the prior hash as satisfying the check for these.
type RewrittenMigrationHistory = {
  currentHash: string;
  priorHashes: readonly string[];
};

const REWRITTEN_MIGRATION_HISTORIES: Readonly<
  Record<string, RewrittenMigrationHistory>
> = {
  // 0.5.0 backfilled slugs inside the migration and built the unique index
  // non-concurrently. The in-transaction backfill exceeded statement_timeout
  // on large corpora, so 0.5.1 rewrote it to build the index CONCURRENTLY and
  // moved the slug backfill into src/scripts/backfill-case-law-slugs.ts.
  "20260603120000_case_law_public_slugs": {
    currentHash:
      "c1ba2ed2049dd11aeab770ae4681e6b47d924bdbbc2ea480d3d0035199e4ab28",
    priorHashes: [
      "4757efe9484615eff7bcba9c34687be4aa9b28e07a71137a3638a3072d8a6d3d",
      "0d7608766b5bbec1031a31e8a004fc093124596b0cbf4446bd4269ffc834a90b",
    ],
  },
  "20260605143000_workflow_pending_fields_index": {
    currentHash:
      "798fdbc4b5e88b6e6aae86815d2aab3b4d4e1c05207f86dd17dce4e2c1ca71fe",
    priorHashes: [
      "0088003d298f869017cf4047a74692a9ddefa4bc246aa6c25ca950ebeb29f918",
    ],
  },
  "20260629123000_arabic_normalize_function": {
    currentHash:
      "5c18323c0211930aee1eb476720d3a6f00b808156f1c72b758ff0458f92a685d",
    priorHashes: [
      "36ccbd00b7e98f6489d4a493ff61eba96eec145b38ef684045ae408fe88521ce",
    ],
  },
  "20260701160000_property_playbook_definition_id": {
    currentHash:
      "428aea6ac33b60c3e401a9c83b1eae0a5b87a9fbadaecd5ab48b38bb31ec64ca",
    priorHashes: [
      "423af8ce20ec27fa4895b37e3caf64f3470e1ebaa92da58cee04ea5c3dc9085e",
    ],
  },
  "20260703233000_account_credential_singleton": {
    currentHash:
      "1e3a3cd7ef1373e6a6c48ded10bd53dc32169066a79fb3a808552d52849fb9ff",
    priorHashes: [
      "ffd1598dc3a56f44095b549438313351e4bfb467b0fdb83c1def5a6d55f74583",
    ],
  },
  "20260707120000_property_role": {
    currentHash:
      "8d47e05862c978c9c7176c2e406e00eb5fc3e73e5f80edda28e7a37320856d93",
    priorHashes: [
      "033466ccb60b0baa4ad4bbd6b8b0f4e116531b4061353ca0b7069178aebfde02",
    ],
  },
  "20260717170000_report_export_notifications": {
    currentHash:
      "094bed35cbea00fc194dc2c2351c9034c55e67b6a6fb808b82cf008345566c3a",
    priorHashes: [
      "11856277db1674f04ecf66d39df8f81242f4347af15d60cf2270ee1e3910a317",
    ],
  },
  "20260719172000_user_created_at_index": {
    currentHash:
      "cd765faf1da8f1da04146b4ca2736bd739a936f3b3b183b8b2448609a4b18447",
    priorHashes: [
      "d75842b57e1ba5f734b2dea9926c76da9fca178d41fafe8005f144cdc4960eee",
    ],
  },
  "20260720140000_machine_api_keys_org_index": {
    currentHash:
      "f8714547100e32110a4cd266fb7836c76d6668c23c6223fe718bb5beb36469d3",
    priorHashes: [
      "c9c7b5d968fe2efa54ef017592d43bb640688ebd6f56b957aca27b45b1412468",
    ],
  },
  "20260731130000_decision_source_document_id": {
    currentHash:
      "85bdb5023fe1126f39e04aad8e7fd3969e2fce28b7d69096cad1a668b8dc45fc",
    priorHashes: [
      "f0dc5e37d764febdad8eba0bc36506c048d22f182f5e0423fd48ad6a26d29a48",
    ],
  },
};

export type LocalMigration = { name: string; hash: string };

type FindUnappliedMigrationsOptions = {
  appliedHashes: ReadonlySet<string>;
  localMigrations: LocalMigration[];
};

export const findUnappliedMigrations = ({
  appliedHashes,
  localMigrations,
}: FindUnappliedMigrationsOptions): LocalMigration[] =>
  localMigrations.filter(({ hash, name }) => {
    if (appliedHashes.has(hash)) {
      return false;
    }
    const supportedHistory = REWRITTEN_MIGRATION_HISTORIES[name];
    if (supportedHistory?.currentHash !== hash) {
      return true;
    }
    return !supportedHistory.priorHashes.some((priorHash) =>
      appliedHashes.has(priorHash),
    );
  });

const hashMigrationFile = async (path: string): Promise<string> =>
  new Bun.CryptoHasher("sha256")
    .update(await Bun.file(path).bytes())
    .digest("hex");

const listLocalMigrations = async (
  migrationsDir: string,
): Promise<LocalMigration[]> => {
  if (!existsSync(migrationsDir)) {
    return [];
  }
  return await Promise.all(
    readdirSync(migrationsDir)
      .filter((name) =>
        existsSync(nodePath.join(migrationsDir, name, "migration.sql")),
      )
      .sort()
      .map(async (name) => ({
        name,
        hash: await hashMigrationFile(
          nodePath.join(migrationsDir, name, "migration.sql"),
        ),
      })),
  );
};

type AssertMigrationHistoryOptions = {
  context: "migrate" | "startup";
  migrationsDir: string;
  queryAppliedHashes: () => Promise<ReadonlySet<string>>;
  remedy: string;
};

export const assertMigrationHistory = async ({
  context,
  migrationsDir,
  queryAppliedHashes,
  remedy,
}: AssertMigrationHistoryOptions): Promise<void> => {
  const localMigrations = await listLocalMigrations(migrationsDir);
  if (localMigrations.length === 0) {
    panic(
      `[${context}] No migration files at ${migrationsDir}; refusing to continue. ` +
        "The runtime image must include apps/api/drizzle/.",
    );
  }

  const appliedHashes = await queryAppliedHashes();
  const unapplied = findUnappliedMigrations({
    appliedHashes,
    localMigrations,
  });
  if (unapplied.length === 0) {
    return;
  }

  const unappliedNames = unapplied.map(({ name }) => name).join(", ");
  panic(
    `[${context}] Schema drift: ${unapplied.length} migration(s) in code are not applied to the database. ` +
      `Code has ${localMigrations.length}; DB has ${appliedHashes.size}. ` +
      `Missing or modified after apply: ${unappliedNames}. ${remedy}`,
  );
};
