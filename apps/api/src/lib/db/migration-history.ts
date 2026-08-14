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
  definitionBody: string;
  isUnique: boolean;
  name: string;
  tableName: string;
};

const rewrittenMigrationHistories = {
  // 0.5.0 backfilled slugs inside the migration and built the unique index
  // non-concurrently. The in-transaction backfill exceeded statement_timeout
  // on large corpora, so 0.5.1 rewrote it to build the index CONCURRENTLY and
  // moved the slug backfill into src/scripts/backfill-case-law-slugs.ts.
  "20260603120000_case_law_public_slugs": {
    currentHash:
      "45c054dee36fdea9f6a9e198b8312e239f37e82d89f25e4323ad45930c90bcae",
    priorHashes: [
      "0871ab1cb27aa8c34c0f41a42c022e27261b9830d4b99627539d256a36855d50",
      "6b7745706b35e0bba31829f9c5262794c7ed4f33455679f28fd998c37eb1718c",
      "4757efe9484615eff7bcba9c34687be4aa9b28e07a71137a3638a3072d8a6d3d",
      "0d7608766b5bbec1031a31e8a004fc093124596b0cbf4446bd4269ffc834a90b",
    ],
    requiredIndexes: [
      {
        definitionBody:
          "ON public.case_law_decisions USING btree (slug) WHERE (slug IS NOT NULL)",
        isUnique: true,
        name: "case_law_decisions_slug_uidx",
        tableName: "case_law_decisions",
      },
    ],
  },
  "20260605143000_workflow_pending_fields_index": {
    currentHash:
      "acfc36c18e0f33499e0adaf90e889db2f0e72eae7fdebabf070f36c5aa32be29",
    priorHashes: [
      "657ac42e4a380c1c13bbb9139278e84bd14cea4d8c1ccfa18345a72b3a2c06e1",
      "00e0820a64f6d5888c79ab9fcd611b599e6622bbc1dc8f4ad668c894af1a41d0",
      "0088003d298f869017cf4047a74692a9ddefa4bc246aa6c25ca950ebeb29f918",
    ],
    requiredIndexes: [
      {
        definitionBody:
          "ON public.fields USING btree (workspace_id) WHERE ((content ->> 'type'::text) = 'pending'::text)",
        isUnique: false,
        name: "fields_pending_workspace_idx",
        tableName: "fields",
      },
    ],
  },
  "20260629123000_arabic_normalize_function": {
    currentHash:
      "2efd4a25545a7a4aea7957fccae54994b4037d1963d6c4f479797500f6b79bf4",
    priorHashes: [
      "36ccbd00b7e98f6489d4a493ff61eba96eec145b38ef684045ae408fe88521ce",
    ],
    requiredIndexes: [
      {
        definitionBody:
          "ON public.contacts USING gin (arabic_normalize((display_name)::text) gin_trgm_ops)",
        isUnique: false,
        name: "contacts_display_name_arabic_norm_trgm_idx",
        tableName: "contacts",
      },
      {
        definitionBody:
          "ON public.contacts USING gin (arabic_normalize((first_name)::text) gin_trgm_ops)",
        isUnique: false,
        name: "contacts_first_name_arabic_norm_trgm_idx",
        tableName: "contacts",
      },
      {
        definitionBody:
          "ON public.contacts USING gin (arabic_normalize((last_name)::text) gin_trgm_ops)",
        isUnique: false,
        name: "contacts_last_name_arabic_norm_trgm_idx",
        tableName: "contacts",
      },
      {
        definitionBody:
          "ON public.contacts USING gin (arabic_normalize((organization_name)::text) gin_trgm_ops)",
        isUnique: false,
        name: "contacts_organization_name_arabic_norm_trgm_idx",
        tableName: "contacts",
      },
    ],
  },
  "20260701160000_property_playbook_definition_id": {
    currentHash:
      "f5e8604a73353044e3164bc67cb1e6c13936e61639a4190f809df5cc60b44f15",
    priorHashes: [
      "423af8ce20ec27fa4895b37e3caf64f3470e1ebaa92da58cee04ea5c3dc9085e",
    ],
    requiredIndexes: [
      {
        definitionBody:
          "ON public.properties USING btree (workspace_id, playbook_definition_id)",
        isUnique: false,
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
      {
        definitionBody:
          "ON public.account USING btree (provider_id) WHERE (provider_id = 'credential'::text)",
        isUnique: true,
        name: "account_credential_singleton_uidx",
        tableName: "account",
      },
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
        definitionBody:
          "ON public.properties USING btree (workspace_id) WHERE (role = 'document-type-classifier'::text)",
        isUnique: true,
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
        definitionBody:
          "ON public.usage_events USING btree (organization_id, idempotency_key) WHERE (idempotency_key IS NOT NULL)",
        isUnique: true,
        name: "usage_events_org_idempotency_key_uidx",
        tableName: "usage_events",
      },
    ],
  },
  "20260717170000_report_export_notifications": {
    currentHash:
      "8aa876b20155b73a71d3d610210412f0a532dca61ee56f89446540e6eee3809e",
    priorHashes: [
      "11856277db1674f04ecf66d39df8f81242f4347af15d60cf2270ee1e3910a317",
    ],
    requiredIndexes: [
      {
        definitionBody:
          "ON public.report_exports USING btree (created_at, id) WHERE ((notification_status = 'pending'::text) AND (status = ANY (ARRAY['completed'::text, 'failed'::text])))",
        isUnique: false,
        name: "report_exports_pending_notification_idx",
        tableName: "report_exports",
      },
    ],
  },
  // The schema effect is unchanged; the current file separates the bounded
  // lock wait from the unbounded execution budget for metadata-only DDL.
  "20260718120000_chat_thread_title_source_default": {
    currentHash:
      "98d87d9f20bcc8f379f428c954abacadab2feb7c9784fe58b2aa0a56f0b4489b",
    priorHashes: [
      "eb0a41ec2f1c3baec7d0371fc9b380a3151ff793edb6e67fef974294582f7930",
    ],
    requiredIndexes: [],
  },
  "20260719172000_user_created_at_index": {
    currentHash:
      "fc18e91775ad01f0cf0a3e1ee4db7f41361d980a270edd46c2dabc1f3315b576",
    priorHashes: [
      "adf459f649b10c8c7472147385a35de7cbda34637cd3ff7f75834cff35516029",
      "60e691372d1eaff6bab6009ed2bc88fff625836b50253203e065c125accdf164",
      "d75842b57e1ba5f734b2dea9926c76da9fca178d41fafe8005f144cdc4960eee",
    ],
    requiredIndexes: [
      {
        definitionBody: 'ON public."user" USING btree (created_at, id)',
        isUnique: false,
        name: "user_createdAt_idx",
        tableName: "user",
      },
    ],
  },
  "20260720140000_machine_api_keys_org_index": {
    currentHash:
      "cc793baee2e7e5c0637cc0f0edbc8cff44706119e7fdd88629d17246857b308f",
    priorHashes: [
      "c9c7b5d968fe2efa54ef017592d43bb640688ebd6f56b957aca27b45b1412468",
    ],
    requiredIndexes: [
      {
        definitionBody:
          "ON public.apikey USING btree ((((metadata)::jsonb ->> 'organizationId'::text))) WHERE (metadata IS NOT NULL)",
        isUnique: false,
        name: "apikey_metadata_organization_id_idx",
        tableName: "apikey",
      },
      {
        definitionBody:
          "ON public.apikey USING btree ((((metadata)::jsonb ->> 'organizationId'::text)), created_at DESC, id DESC) WHERE (metadata IS NOT NULL)",
        isUnique: false,
        name: "apikey_org_keyset_idx",
        tableName: "apikey",
      },
    ],
  },
  // The schema effect is unchanged; the current file preserves the caller's
  // timeout settings and delegates its replay-safe cutover to the reconciler.
  "20260729120000_case_law_filter_search_index": {
    currentHash:
      "39cd50f9708a46b92a877ddb7e0f99857fdd1feec439bf15ce4997a53692e8b5",
    priorHashes: [
      "d5694708690bf58d1eb66f4e7b809e3e9a84be5978d7bea7a5f011a692993e53",
      "6b0f5b13272eb84bb333ed0ae2a5e0f74c2459566938e2938b66667d4f0de433",
    ],
    requiredIndexes: [],
  },
  // The schema effect is unchanged; the current file gives the conversion a
  // finite execution budget when the session starts at PostgreSQL's default.
  "20260729150000_timestamptz_everywhere": {
    currentHash:
      "ecd84e833a249b738353900445cf4f8ef2dac475492ccec8fbd5cbba875863c3",
    priorHashes: [
      "3c60d3d8fe57b06efd452dc6f9580c5bbfb85e9b606cbf7cc6d3437cd2b1dda1",
    ],
    requiredIndexes: [],
  },
  "20260731130000_decision_source_document_id": {
    currentHash:
      "479cd1cd88870fb947ea7da61411f76d96a18f07bf7cc308465ce8d62dc8c40e",
    priorHashes: [
      "f0dc5e37d764febdad8eba0bc36506c048d22f182f5e0423fd48ad6a26d29a48",
      "15d92f17395b90ef96815823e22b7928cdeaa5ee39021428b7268ffcf0fe4b84",
    ],
    requiredIndexes: [
      {
        definitionBody:
          "ON public.case_law_decisions USING btree (source_id, source_document_id) WHERE (source_document_id IS NOT NULL)",
        isUnique: true,
        name: "case_law_decisions_source_document_idx",
        tableName: "case_law_decisions",
      },
      {
        definitionBody:
          "ON public.case_law_decisions USING btree (source_id, case_number, language) WHERE (source_document_id IS NULL)",
        isUnique: true,
        name: "case_law_decisions_source_case_lang_null_idx",
        tableName: "case_law_decisions",
      },
    ],
  },
  // The schema effect is unchanged; the current file separates the bounded
  // lock wait from the unbounded execution budget for metadata-only DDL.
  "20260731170000_case_law_corpus_generation_backfill": {
    currentHash:
      "4e35ff3e0fce8117382eb87ff73df18751954da90014ca9a2619a4a544de89e8",
    priorHashes: [
      "6eeb473a0902a7a807133c5057c2b582c2d40f748705b36d967a75bec6df8a7b",
    ],
    requiredIndexes: [],
  },
  // The file was amended after databases had already applied it: review
  // tightened the legacy-timer repair to skip owners without current
  // organization or matter access and to preserve billed minutes. The index
  // DDL is unchanged, and `time_entries_one_active_timer_per_user_idx` is
  // already registered in ONLINE_MIGRATION_INDEXES with its create statement,
  // so redeclaring it here would only duplicate that registration.
  "20260809120002_unique_active_time_entry_timer": {
    currentHash:
      "79b9b91afee0ebb5ab03a1be704b6b2e42b563a9f6c8c273ba97f9512973018b",
    priorHashes: [
      "6d9baf23d92a3efe2569cc43c9b5de09b80ca637ef4c08536f01a141afca9bda",
      "3aaf8809173eda72b77300a20904f12d48e1858f7f34293a5860bc7e64c1fd6c",
      "9b73e4aabcc8dad6e2efdbf1c1e6dd35c623bf94582fac1cb7d5b8693578a504",
      "6fd29ef3ec3c1961861f567637ebb1b0c5a2b3824f425289c3b866b7c65242c2",
      "f6cd037afe4f392121d35d8a4968e15c1868a6af2912511958ec3776a0f42905",
      "418cdfdd44922fe1025f58da8cb1d277a19964526e3ed21184ec99a9c017bc57",
      "bf08ac44a1eedbae56a337ad30e431fb6b3bfe6ae44fa6c59d01d7018191fa54",
      "f11e79ae3979f17900652c8d823d84f065a550a8ea9f05e2262ea509fe7379bd",
      "4b0b861a732c7faebb27f5970bb3a4f9943f3dc332fef3c8cbd8c468c2f78ba0",
      "72db38c518a8ef562e279777a31d264b5cd16830596a962826315704dc5a6f9e",
    ],
    requiredIndexes: [],
  },
} as const satisfies Readonly<Record<string, RewrittenMigrationHistory>>;

export const REWRITTEN_MIGRATION_HISTORIES: Readonly<
  Record<string, RewrittenMigrationHistory>
> = rewrittenMigrationHistories;

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
