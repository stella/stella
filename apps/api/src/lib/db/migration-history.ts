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
  requiredIndexes: readonly RequiredMigrationIndex[];
};

export type RequiredMigrationIndex = {
  name: string;
  tableName: string;
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
      "6b7745706b35e0bba31829f9c5262794c7ed4f33455679f28fd998c37eb1718c",
    priorHashes: [
      "4757efe9484615eff7bcba9c34687be4aa9b28e07a71137a3638a3072d8a6d3d",
      "0d7608766b5bbec1031a31e8a004fc093124596b0cbf4446bd4269ffc834a90b",
    ],
    requiredIndexes: [
      {
        name: "case_law_decisions_slug_uidx",
        tableName: "case_law_decisions",
      },
    ],
  },
  "20260605143000_workflow_pending_fields_index": {
    currentHash:
      "798fdbc4b5e88b6e6aae86815d2aab3b4d4e1c05207f86dd17dce4e2c1ca71fe",
    priorHashes: [
      "0088003d298f869017cf4047a74692a9ddefa4bc246aa6c25ca950ebeb29f918",
    ],
    requiredIndexes: [
      { name: "fields_pending_workspace_idx", tableName: "fields" },
    ],
  },
  "20260629123000_arabic_normalize_function": {
    currentHash:
      "5c18323c0211930aee1eb476720d3a6f00b808156f1c72b758ff0458f92a685d",
    priorHashes: [
      "36ccbd00b7e98f6489d4a493ff61eba96eec145b38ef684045ae408fe88521ce",
    ],
    requiredIndexes: [
      {
        name: "contacts_display_name_arabic_norm_trgm_idx",
        tableName: "contacts",
      },
      {
        name: "contacts_first_name_arabic_norm_trgm_idx",
        tableName: "contacts",
      },
      {
        name: "contacts_last_name_arabic_norm_trgm_idx",
        tableName: "contacts",
      },
      {
        name: "contacts_organization_name_arabic_norm_trgm_idx",
        tableName: "contacts",
      },
    ],
  },
  "20260701160000_property_playbook_definition_id": {
    currentHash:
      "428aea6ac33b60c3e401a9c83b1eae0a5b87a9fbadaecd5ab48b38bb31ec64ca",
    priorHashes: [
      "423af8ce20ec27fa4895b37e3caf64f3470e1ebaa92da58cee04ea5c3dc9085e",
    ],
    requiredIndexes: [
      {
        name: "properties_workspace_playbook_definition_idx",
        tableName: "properties",
      },
    ],
  },
  "20260703233000_account_credential_singleton": {
    currentHash:
      "9de5d6af3b0acd569ebffa1452e7e441939a1afafb9c6bc59bd461e87e1586bc",
    priorHashes: [
      "ffd1598dc3a56f44095b549438313351e4bfb467b0fdb83c1def5a6d55f74583",
    ],
    requiredIndexes: [
      { name: "account_credential_singleton_uidx", tableName: "account" },
    ],
  },
  "20260707120000_property_role": {
    currentHash:
      "a3e5b0faa0bf5fc1249848c25707c589d00a5ef1a969efcd6fa313f483030c54",
    priorHashes: [
      "033466ccb60b0baa4ad4bbd6b8b0f4e116531b4061353ca0b7069178aebfde02",
    ],
    requiredIndexes: [
      {
        name: "properties_ws_document_type_classifier_unq",
        tableName: "properties",
      },
    ],
  },
  "20260717110000_usage_event_idempotency": {
    currentHash:
      "c769f5c5257528acb310673a276549138a2e44006eeed8dc10beb4153a54cddb",
    priorHashes: [
      "dd0acd610eb979875428ca7778d97cce4baf33b4332479434f66e68c729b2433",
    ],
    requiredIndexes: [
      {
        name: "usage_events_org_idempotency_key_uidx",
        tableName: "usage_events",
      },
    ],
  },
  "20260717170000_report_export_notifications": {
    currentHash:
      "094bed35cbea00fc194dc2c2351c9034c55e67b6a6fb808b82cf008345566c3a",
    priorHashes: [
      "11856277db1674f04ecf66d39df8f81242f4347af15d60cf2270ee1e3910a317",
    ],
    requiredIndexes: [
      {
        name: "report_exports_pending_notification_idx",
        tableName: "report_exports",
      },
    ],
  },
  "20260719172000_user_created_at_index": {
    currentHash:
      "cd765faf1da8f1da04146b4ca2736bd739a936f3b3b183b8b2448609a4b18447",
    priorHashes: [
      "d75842b57e1ba5f734b2dea9926c76da9fca178d41fafe8005f144cdc4960eee",
    ],
    requiredIndexes: [{ name: "user_createdAt_idx", tableName: "user" }],
  },
  "20260720140000_machine_api_keys_org_index": {
    currentHash:
      "f8714547100e32110a4cd266fb7836c76d6668c23c6223fe718bb5beb36469d3",
    priorHashes: [
      "c9c7b5d968fe2efa54ef017592d43bb640688ebd6f56b957aca27b45b1412468",
    ],
    requiredIndexes: [
      { name: "apikey_metadata_organization_id_idx", tableName: "apikey" },
      { name: "apikey_org_keyset_idx", tableName: "apikey" },
    ],
  },
  "20260731130000_decision_source_document_id": {
    currentHash:
      "15d92f17395b90ef96815823e22b7928cdeaa5ee39021428b7268ffcf0fe4b84",
    priorHashes: [
      "f0dc5e37d764febdad8eba0bc36506c048d22f182f5e0423fd48ad6a26d29a48",
    ],
    requiredIndexes: [
      {
        name: "case_law_decisions_source_document_idx",
        tableName: "case_law_decisions",
      },
      {
        name: "case_law_decisions_source_case_lang_null_idx",
        tableName: "case_law_decisions",
      },
    ],
  },
};

export const REWRITTEN_MIGRATION_INDEXES: readonly RequiredMigrationIndex[] =
  Object.values(REWRITTEN_MIGRATION_HISTORIES).flatMap(
    ({ requiredIndexes }) => requiredIndexes,
  );

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
