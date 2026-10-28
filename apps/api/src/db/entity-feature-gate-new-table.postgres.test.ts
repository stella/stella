import { panic } from "better-result";
import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { foreignKey, PgTable, uuid } from "drizzle-orm/pg-core";

import {
  SETTING_ORGANIZATION_ID,
  SETTING_USER_ID,
  SETTING_WORKSPACE_ACCESS_MODE,
  SETTING_WORKSPACE_IDS,
  WORKSPACE_ACCESS_MODE,
} from "@/api/db/rls";
import * as schema from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { LEGAL_LISTS_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import {
  entityFeatureGateRoutines,
  entityFeatureGateTableSql,
  routineReplacementSql,
} from "../../scripts/entity-feature-gate-ddl";
import {
  entityFeatureGateChecks,
  entityFeatureGateColumns,
  entityFeatureWorkspaceGateColumns,
} from "./entity-feature-gate-columns";
import { entityFeatureGateMetadata } from "./entity-feature-gate-metadata";
import { readEffectiveEntityFeatureGateDefinitions } from "./entity-feature-gate-migrations";
import { ENTITY_FEATURE_GATE_REPAIR } from "./entity-feature-gate-repair";
import { entityFeaturePolicies } from "./entity-feature-policies";
import type { OnlineMigrationConnection } from "./online-migration-connection";
import { p, stella, workspaceCheck } from "./schema/common";
import { legalListItemSources } from "./schema/lists";

const FIXTURE_TABLE = "entity_feature_gate_new_table_fixture";
const fixtureTable = p.pgTable(
  FIXTURE_TABLE,
  {
    ...entityFeatureGateColumns(),
    ...entityFeatureWorkspaceGateColumns(),
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    sourceId: uuid("source_id").notNull(),
  },
  (table) => [
    ...entityFeatureGateChecks(table),
    ...entityFeaturePolicies(
      table,
      new Map([
        [
          table.sourceId,
          { kind: "owned-by-parent", parent: legalListItemSources },
        ],
      ]),
    ),
    foreignKey({
      columns: [table.sourceId],
      foreignColumns: [legalListItemSources.id],
    }).onDelete("cascade"),
    p.pgPolicy("workspace_select", {
      for: "select",
      to: stella,
      using: workspaceCheck,
    }),
    p.pgPolicy("workspace_insert", {
      for: "insert",
      to: stella,
      withCheck: workspaceCheck,
    }),
    p.pgPolicy("workspace_update", {
      for: "update",
      to: stella,
      using: workspaceCheck,
      withCheck: workspaceCheck,
    }),
    p
      .index("entity_feature_gate_new_table_ef_source_idx")
      .on(table.workspaceId, table.sourceId),
  ],
);

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const breakpoint = "--> statement-breakpoint";

const applyStatements = async (client: SQL, statements: readonly string[]) => {
  await client.unsafe("BEGIN");
  try {
    for (const statement of statements.flatMap((value) =>
      value.split(breakpoint),
    )) {
      if (statement.trim() !== "") {
        await client.unsafe(statement);
      }
    }
    await client.unsafe("COMMIT");
  } catch (error) {
    await client.unsafe("ROLLBACK");
    throw error;
  }
};

const migrationConnection = (client: SQL): OnlineMigrationConnection => ({
  execute: async (statement, params = []) => {
    await client.unsafe(statement, [...params]);
  },
  query: async (statement, params = []) =>
    await client.unsafe(statement, [...params]),
  release: () => undefined,
});

describe.skipIf(!runPostgresTests)(
  "entity feature gates for a table added after the gate migration",
  () => {
    test("generated DDL repairs, propagates and enforces the new table gate", async () => {
      if (databaseUrl === undefined) {
        panic("DATABASE_URL required");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const client = openClient().sql;
        const tables = [
          ...Object.values(schema).filter((table) => is(table, PgTable)),
          fixtureTable,
        ];
        const originalDescriptors = entityFeatureGateMetadata(
          tables.slice(0, -1),
        );
        const descriptors = entityFeatureGateMetadata(tables);
        const effective = await readEffectiveEntityFeatureGateDefinitions();
        // Restored as their owners, the way the generator replaces them.
        const originalRoutines = entityFeatureGateRoutines(
          originalDescriptors,
        ).flatMap(([name, sql]) => routineReplacementSql(name, [sql]));
        const generated = entityFeatureGateTableSql(
          tables,
          descriptors,
          effective,
        );

        const organizationId = mintAuthProviderId<"organization">();
        const workspaceId = createSafeId<"workspace">();
        const itemEntityId = createSafeId<"entity">();
        const sourceEntityId = createSafeId<"entity">();
        const sourceVersionId = createSafeId<"entityVersion">();
        const listId = createSafeId<"legalList">();
        const sourceId = createSafeId<"legalListItemSource">();
        const fixtureId = Bun.randomUUIDv7();
        try {
          await client.unsafe(`CREATE TABLE public.${FIXTURE_TABLE} (
            entity_feature_gate text NOT NULL DEFAULT 'pending',
            entity_feature_workspace_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
            id uuid PRIMARY KEY, workspace_id uuid NOT NULL,
            source_id uuid NOT NULL REFERENCES public.legal_list_item_sources(id) ON DELETE CASCADE
          );
          ALTER TABLE public.${FIXTURE_TABLE} ENABLE ROW LEVEL SECURITY;
          ALTER TABLE public.${FIXTURE_TABLE} FORCE ROW LEVEL SECURITY;
          GRANT SELECT, INSERT, UPDATE, DELETE ON public.${FIXTURE_TABLE} TO stella;
          CREATE POLICY workspace_select ON public.${FIXTURE_TABLE} FOR SELECT TO stella
            USING (workspace_id = ANY(COALESCE(NULLIF(current_setting('app.workspace_ids', true), '')::uuid[], ARRAY[]::uuid[])));
          CREATE POLICY workspace_insert ON public.${FIXTURE_TABLE} FOR INSERT TO stella
            WITH CHECK (workspace_id = ANY(COALESCE(NULLIF(current_setting('app.workspace_ids', true), '')::uuid[], ARRAY[]::uuid[])));
          CREATE POLICY workspace_update ON public.${FIXTURE_TABLE} FOR UPDATE TO stella
            USING (workspace_id = ANY(COALESCE(NULLIF(current_setting('app.workspace_ids', true), '')::uuid[], ARRAY[]::uuid[])))
            WITH CHECK (workspace_id = ANY(COALESCE(NULLIF(current_setting('app.workspace_ids', true), '')::uuid[], ARRAY[]::uuid[])));`);
          await applyStatements(client, generated);

          expect(
            await ENTITY_FEATURE_GATE_REPAIR.readCompletion(
              migrationConnection(client),
            ),
          ).toEqual({ type: "complete" });

          await client`INSERT INTO organization (id, name, slug, created_at)
            VALUES (${organizationId}, 'New gate table', ${`new-gate-${organizationId}`}, now())`;
          await client`INSERT INTO workspaces (id, organization_id, name, reference)
            VALUES (${workspaceId}, ${organizationId}, 'New gate table', ${`new-gate-${workspaceId}`})`;
          await client`INSERT INTO entities (id, workspace_id, kind, list_item_type, name)
            VALUES (${itemEntityId}, ${workspaceId}, 'task', 'fact', 'List fact'),
              (${sourceEntityId}, ${workspaceId}, 'document', NULL, 'Source document')`;
          await client`INSERT INTO entity_versions (id, workspace_id, entity_id)
            VALUES (${sourceVersionId}, ${workspaceId}, ${sourceEntityId})`;
          await client`INSERT INTO legal_lists (id, workspace_id, name)
            VALUES (${listId}, ${workspaceId}, 'Facts')`;
          await client`INSERT INTO legal_list_items (entity_id, workspace_id, list_id, position)
            VALUES (${itemEntityId}, ${workspaceId}, ${listId}, 'a')`;
          await client`INSERT INTO legal_list_item_sources
            (id, workspace_id, list_id, item_entity_id, source_entity_id,
             source_entity_version_id, locator)
            VALUES (${sourceId}, ${workspaceId}, ${listId}, ${itemEntityId},
              ${sourceEntityId}, ${sourceVersionId}, '{"type":"entity"}'::jsonb)`;
          await client.unsafe(
            `INSERT INTO public.${FIXTURE_TABLE} (id, workspace_id, source_id) VALUES ($1, $2, $3)`,
            [fixtureId, workspaceId, sourceId],
          );
          expect(
            (
              await client.unsafe(
                `SELECT entity_feature_gate AS gate FROM public.${FIXTURE_TABLE} WHERE id = $1`,
                [fixtureId],
              )
            ).at(0)?.gate,
          ).toBe(LEGAL_LISTS_FEATURE_ID);

          await client`UPDATE entities SET list_item_type = 'task' WHERE id = ${itemEntityId}`;
          expect(
            (
              await client.unsafe(
                `SELECT entity_feature_gate AS gate FROM public.${FIXTURE_TABLE} WHERE id = $1`,
                [fixtureId],
              )
            ).at(0)?.gate,
          ).toBe("open");
          await client`UPDATE entities SET list_item_type = 'fact' WHERE id = ${itemEntityId}`;

          for (const [features, visible] of [
            [[], false],
            [[LEGAL_LISTS_FEATURE_ID], true],
          ] as const) {
            const rows = await client.begin(async (tx) => {
              await tx`SELECT set_config('role', 'stella', true),
                set_config(${SETTING_ORGANIZATION_ID}, ${organizationId}, true),
                set_config(${SETTING_USER_ID}, '', true),
                set_config(${SETTING_WORKSPACE_IDS}, ${`{${workspaceId}}`}, true),
                set_config(${SETTING_WORKSPACE_ACCESS_MODE}, ${WORKSPACE_ACCESS_MODE.explicit}, true),
                set_config('app.enabled_features', ${JSON.stringify(features)}, true)`;
              return await tx.unsafe(
                `SELECT id FROM public.${FIXTURE_TABLE} WHERE id = $1`,
                [fixtureId],
              );
            });
            expect(rows).toHaveLength(visible ? 1 : 0);
          }
        } finally {
          await client.unsafe(
            `DROP TABLE IF EXISTS public.${FIXTURE_TABLE} CASCADE`,
          );
          await applyStatements(client, originalRoutines);
          await client`DELETE FROM organization WHERE id = ${organizationId}`;
        }
      });
    }, 120_000); // timeout: applies generated DDL, including concurrent indexes, to the migrated database
  },
);
