import { panic } from "better-result";
import type { SQL, TransactionSQL } from "bun";
import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  SETTING_ORGANIZATION_ID,
  SETTING_USER_ID,
  SETTING_WORKSPACE_ACCESS_MODE,
  SETTING_WORKSPACE_IDS,
  WORKSPACE_ACCESS_MODE,
} from "@/api/db/rls";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { LEGAL_LISTS_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const waitUntilBlocked = async (observer: SQL, pid: number) => {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const [row] = await observer`
      SELECT cardinality(pg_blocking_pids(${pid}::int)) > 0 AS blocked`;
    if (row?.blocked === true) {
      return;
    }
    await Bun.sleep(10);
  }
  panic(`backend ${String(pid)} never blocked`);
};

const backendPid = async (client: SQL): Promise<number> => {
  const [row] = await client`SELECT pg_backend_pid() AS pid`;
  const pid: unknown = row?.pid;
  if (typeof pid !== "number") {
    panic("Expected a PostgreSQL backend pid");
  }
  return pid;
};

type GateFixture = {
  organizationId: SafeId<"organization">;
  workspaceA: SafeId<"workspace">;
  workspaceB: SafeId<"workspace">;
  taskA: SafeId<"entity">;
  factA: SafeId<"entity">;
  factB: SafeId<"entity">;
  taskVersionA: SafeId<"entityVersion">;
  factVersionA: SafeId<"entityVersion">;
  factVersionB: SafeId<"entityVersion">;
  propertyA: SafeId<"property">;
  propertyReferenceA: SafeId<"property">;
  propertyB: SafeId<"property">;
  fieldForCascadeA: SafeId<"field">;
  fieldForReferenceA: SafeId<"field">;
  fieldB: SafeId<"field">;
};

const seedGateFixture = async (client: SQL): Promise<GateFixture> => {
  const fixture: GateFixture = {
    organizationId: mintAuthProviderId<"organization">(),
    workspaceA: createSafeId<"workspace">(),
    workspaceB: createSafeId<"workspace">(),
    taskA: createSafeId<"entity">(),
    factA: createSafeId<"entity">(),
    factB: createSafeId<"entity">(),
    taskVersionA: createSafeId<"entityVersion">(),
    factVersionA: createSafeId<"entityVersion">(),
    factVersionB: createSafeId<"entityVersion">(),
    propertyA: createSafeId<"property">(),
    propertyReferenceA: createSafeId<"property">(),
    propertyB: createSafeId<"property">(),
    fieldForCascadeA: createSafeId<"field">(),
    fieldForReferenceA: createSafeId<"field">(),
    fieldB: createSafeId<"field">(),
  };
  const fixtureName = `entity-gate-${fixture.organizationId}`;

  await client`INSERT INTO organization (id, name, slug, created_at)
    VALUES (${fixture.organizationId}, 'Entity gate test', ${fixtureName}, now())`;
  await client`INSERT INTO workspaces (id, organization_id, name, reference)
    VALUES (${fixture.workspaceA}, ${fixture.organizationId}, 'Gate matter A', ${`${fixtureName}-a`}),
      (${fixture.workspaceB}, ${fixture.organizationId}, 'Gate matter B', ${`${fixtureName}-b`})`;
  await client`INSERT INTO entities (id, workspace_id, kind, list_item_type, name)
    VALUES (${fixture.taskA}, ${fixture.workspaceA}, 'task', 'task', 'Ordinary task'),
      (${fixture.factA}, ${fixture.workspaceA}, 'task', 'task', 'Reclassifiable fact'),
      (${fixture.factB}, ${fixture.workspaceB}, 'task', 'fact', 'Second fact')`;
  await client`INSERT INTO entity_versions (id, workspace_id, entity_id)
    VALUES (${fixture.taskVersionA}, ${fixture.workspaceA}, ${fixture.taskA}),
      (${fixture.factVersionA}, ${fixture.workspaceA}, ${fixture.factA}),
      (${fixture.factVersionB}, ${fixture.workspaceB}, ${fixture.factB})`;
  await client`INSERT INTO properties (id, workspace_id, name, status, content, tool)
    VALUES (${fixture.propertyA}, ${fixture.workspaceA}, 'Gate property A', 'fresh',
      '{"version":1,"type":"text"}'::jsonb, '{"version":1,"type":"manual-input"}'::jsonb),
      (${fixture.propertyReferenceA}, ${fixture.workspaceA}, 'Gate reference property A', 'fresh',
      '{"version":1,"type":"text"}'::jsonb, '{"version":1,"type":"manual-input"}'::jsonb),
      (${fixture.propertyB}, ${fixture.workspaceB}, 'Gate property B', 'fresh',
      '{"version":1,"type":"text"}'::jsonb, '{"version":1,"type":"manual-input"}'::jsonb)`;
  await client`INSERT INTO fields (id, workspace_id, property_id, entity_version_id, content)
    VALUES (${fixture.fieldForCascadeA}, ${fixture.workspaceA}, ${fixture.propertyA},
      ${fixture.factVersionA}, '{"version":1,"type":"text","value":"cascade"}'::jsonb),
      (${fixture.fieldForReferenceA}, ${fixture.workspaceA}, ${fixture.propertyReferenceA},
      ${fixture.taskVersionA}, '{"version":1,"type":"text","value":"reference"}'::jsonb),
      (${fixture.fieldB}, ${fixture.workspaceB}, ${fixture.propertyB},
      ${fixture.factVersionB}, '{"version":1,"type":"text","value":"source"}'::jsonb)`;
  return fixture;
};

type AppScopeOptions = {
  organizationId: string;
  workspaceIds: readonly string[];
  featureIds: readonly string[];
};

const inAppScope = async <T>(
  client: SQL,
  { organizationId, workspaceIds, featureIds }: AppScopeOptions,
  run: (tx: TransactionSQL) => Promise<T>,
): Promise<T> =>
  await client.begin(async (tx) => {
    await tx`SELECT set_config('role', 'stella', true),
      set_config(${SETTING_ORGANIZATION_ID}, ${organizationId}, true),
      set_config(${SETTING_USER_ID}, '', true),
      set_config(${SETTING_WORKSPACE_IDS}, ${`{${workspaceIds.join(",")}}`}, true),
      set_config(${SETTING_WORKSPACE_ACCESS_MODE}, ${WORKSPACE_ACCESS_MODE.explicit}, true),
      set_config('app.enabled_features', ${JSON.stringify(featureIds)}, true)`;
    return await run(tx);
  });

const gateOf = async (
  client: SQL,
  relation:
    | "entity_versions"
    | "fields"
    | "extracted_content"
    | "search_documents",
  id: string,
) => {
  switch (relation) {
    case "entity_versions":
      return await client`SELECT entity_feature_gate AS gate FROM entity_versions WHERE id = ${id}`;
    case "fields":
      return await client`SELECT entity_feature_gate AS gate FROM fields WHERE id = ${id}`;
    case "extracted_content":
      return await client`SELECT entity_feature_gate AS gate FROM extracted_content WHERE entity_id = ${id}`;
    case "search_documents":
      return await client`SELECT entity_feature_gate AS gate FROM search_documents WHERE entity_id = ${id}`;
  }
  return panic(`Unsupported entity feature gate relation: ${relation}`);
};

describe.skipIf(!runPostgresTests)(
  "entity feature gate maintenance (postgres)",
  () => {
    test("parent insertion repairs an existing missing reference", async () => {
      if (!databaseUrl) {
        panic("DATABASE_URL required");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { sql: client } = openClient();
        const fixture = await seedGateFixture(client);
        const runId = createSafeId<"flowRun">();
        const stepId = createSafeId<"flowRunStep">();
        const restoredEntityId = createSafeId<"entity">();
        try {
          await client.begin(async (tx) => {
            // Model a historical orphan before its NOT VALID FK was installed.
            await tx`ALTER TABLE flow_run_steps DROP CONSTRAINT flow_run_steps_review_task_entity_id_entities_id_fk`;
            await tx`INSERT INTO flow_runs (id, workspace_id, definition_snapshot, trigger_source)
              VALUES (${runId}, ${fixture.workspaceA}, '{}'::jsonb, '{}'::jsonb)`;
            await tx`INSERT INTO flow_run_steps (id, workspace_id, run_id, index, kind, review_task_entity_id)
              VALUES (${stepId}, ${fixture.workspaceA}, ${runId}, 0, 'review-gate', ${restoredEntityId})`;
            await tx`ALTER TABLE flow_run_steps ADD CONSTRAINT flow_run_steps_review_task_entity_id_entities_id_fk
              FOREIGN KEY (review_task_entity_id) REFERENCES entities(id) ON DELETE SET NULL NOT VALID`;
            const before =
              await tx`SELECT entity_feature_gate AS gate FROM flow_run_steps WHERE id = ${stepId}`;
            expect(before).toEqual([{ gate: "missing" }]);
            await tx`INSERT INTO entities (id, workspace_id, kind, list_item_type, name)
              VALUES (${restoredEntityId}, ${fixture.workspaceA}, 'task', 'fact', 'Restored parent')`;
            const after =
              await tx`SELECT entity_feature_gate AS gate FROM flow_run_steps WHERE id = ${stepId}`;
            expect(after).toEqual([{ gate: "legal-lists" }]);
          });
        } finally {
          await client`DELETE FROM organization WHERE id = ${fixture.organizationId}`;
        }
      });
    }, 20_000);

    test("inserts and reference changes inherit gates; root reclassification refreshes descendants", async () => {
      if (!databaseUrl) {
        panic("DATABASE_URL required");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { sql: client } = openClient();
        const fixture = await seedGateFixture(client);
        const extractionForTaskA = fixture.taskA;
        const searchForFactA = fixture.factA;
        try {
          await client`INSERT INTO extracted_content (entity_id, organization_id, workspace_id,
          source_entity_version_id, source_field_id, ciphertext, iv, char_count)
          VALUES (${fixture.factA}, ${fixture.organizationId}, ${fixture.workspaceA},
            ${fixture.factVersionA}, ${fixture.fieldForCascadeA}, decode('01','hex'), decode('02','hex'), 1),
          (${extractionForTaskA}, ${fixture.organizationId}, ${fixture.workspaceA},
            ${fixture.taskVersionA}, ${fixture.fieldForReferenceA}, decode('03','hex'), decode('04','hex'), 1)`;
          await client`INSERT INTO search_documents (entity_id, organization_id, workspace_id, kind, title, searchable_text)
          VALUES (${searchForFactA}, ${fixture.organizationId}, ${fixture.workspaceA}, 'task', 'Cascade fact', 'Cascade fact')`;

          expect(
            (await gateOf(client, "entity_versions", fixture.factVersionA)).at(
              0,
            )?.gate,
          ).toBe("open");
          expect(
            (await gateOf(client, "fields", fixture.fieldForCascadeA)).at(0)
              ?.gate,
          ).toBe("open");
          expect(
            (await gateOf(client, "extracted_content", fixture.factA)).at(0)
              ?.gate,
          ).toBe("open");
          expect(
            (await gateOf(client, "search_documents", searchForFactA)).at(0)
              ?.gate,
          ).toBe("open");

          await client`UPDATE fields SET entity_version_id = ${fixture.factVersionA}
          WHERE id = ${fixture.fieldForReferenceA}`;
          expect(
            (await gateOf(client, "fields", fixture.fieldForReferenceA)).at(0)
              ?.gate,
          ).toBe("open");

          await client`UPDATE entities SET list_item_type = 'fact' WHERE id = ${fixture.factA}`;
          expect(
            (await gateOf(client, "entity_versions", fixture.factVersionA)).at(
              0,
            )?.gate,
          ).toBe("legal-lists");
          expect(
            (await gateOf(client, "fields", fixture.fieldForCascadeA)).at(0)
              ?.gate,
          ).toBe("legal-lists");
          expect(
            (await gateOf(client, "extracted_content", fixture.factA)).at(0)
              ?.gate,
          ).toBe("legal-lists");
          expect(
            (await gateOf(client, "search_documents", searchForFactA)).at(0)
              ?.gate,
          ).toBe("legal-lists");
          expect(
            (await gateOf(client, "fields", fixture.fieldForReferenceA)).at(0)
              ?.gate,
          ).toBe("legal-lists");
          expect(
            (await gateOf(client, "extracted_content", extractionForTaskA)).at(
              0,
            )?.gate,
          ).toBe("legal-lists");

          await client`UPDATE entities SET list_item_type = 'task' WHERE id = ${fixture.factA}`;
          expect(
            (await gateOf(client, "entity_versions", fixture.factVersionA)).at(
              0,
            )?.gate,
          ).toBe("open");
          expect(
            (await gateOf(client, "fields", fixture.fieldForCascadeA)).at(0)
              ?.gate,
          ).toBe("open");
          expect(
            (await gateOf(client, "extracted_content", fixture.factA)).at(0)
              ?.gate,
          ).toBe("open");
          expect(
            (await gateOf(client, "search_documents", searchForFactA)).at(0)
              ?.gate,
          ).toBe("open");

          await client`UPDATE entities SET list_item_type = 'fact' WHERE id = ${fixture.factA}`;
          await client`UPDATE extracted_content SET source_entity_version_id = ${fixture.factVersionA},
          source_field_id = ${fixture.fieldForCascadeA} WHERE entity_id = ${extractionForTaskA}`;
          expect(
            (await gateOf(client, "extracted_content", extractionForTaskA)).at(
              0,
            )?.gate,
          ).toBe("legal-lists");

          for (const featureIds of [[], [LEGAL_LISTS_FEATURE_ID]]) {
            await inAppScope(
              client,
              {
                organizationId: fixture.organizationId,
                workspaceIds: [fixture.workspaceA],
                featureIds,
              },
              async (tx) => {
                const extractedRows =
                  await tx`SELECT entity_id FROM extracted_content WHERE entity_id = ${extractionForTaskA}`;
                expect(extractedRows).toEqual(
                  featureIds.length === 0
                    ? []
                    : [{ entity_id: extractionForTaskA }],
                );
                const searchRows =
                  await tx`SELECT entity_id FROM search_documents WHERE entity_id = ${searchForFactA}`;
                expect(searchRows).toEqual(
                  featureIds.length === 0
                    ? []
                    : [{ entity_id: searchForFactA }],
                );
              },
            );
          }
        } finally {
          await client`DELETE FROM organization WHERE id = ${fixture.organizationId}`;
        }
      });
    }, 20_000);

    test("dependent verification claims inherit the run organization gate", async () => {
      if (!databaseUrl) {
        panic("DATABASE_URL required");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { sql: client } = openClient();
        const fixture = await seedGateFixture(client);
        const runId = createSafeId<"legalListVerificationRun">();
        const claimId = createSafeId<"legalListClaim">();
        try {
          await client`UPDATE entities SET list_item_type = 'fact' WHERE id = ${fixture.factB}`;
          await client`INSERT INTO legal_list_verification_runs (id, organization_id, workspace_id,
          entity_id, file_field_id, entity_version_id, content_sha256, evidence)
          VALUES (${runId}, ${fixture.organizationId}, ${fixture.workspaceB}, ${fixture.factB},
            ${createSafeId<"field">()}, ${fixture.factVersionB}, repeat('a', 64),
            '{"facts":[],"listId":"fixture-list"}'::jsonb)`;
          await client`INSERT INTO legal_list_claims (id, workspace_id, run_id, position, type, state, text, anchor)
          VALUES (${claimId}, ${fixture.workspaceB}, ${runId}, 0, 'fact', 'nocover', 'Pinned claim',
            '{"type":"docx-block"}'::jsonb)`;
          const [stored] = await client`SELECT entity_feature_gate AS gate,
          entity_feature_organization_ids = ARRAY[${fixture.organizationId}::text] AS only_parent_organization
          FROM legal_list_claims WHERE id = ${claimId}`;
          expect(stored).toEqual({
            gate: "legal-lists",
            only_parent_organization: true,
          });

          await inAppScope(
            client,
            {
              organizationId: fixture.organizationId,
              workspaceIds: [fixture.workspaceB],
              featureIds: [LEGAL_LISTS_FEATURE_ID],
            },
            async (tx) => {
              const claimRows =
                await tx`SELECT id FROM legal_list_claims WHERE id = ${claimId}`;
              expect(claimRows).toEqual([{ id: claimId }]);
            },
          );
        } finally {
          await client`DELETE FROM organization WHERE id = ${fixture.organizationId}`;
        }
      });
    }, 20_000);

    test("unchanged parent gates do not write dependent claim gate columns", async () => {
      if (!databaseUrl) {
        panic("DATABASE_URL required");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const client = openClient().sql;
        const fixture = await seedGateFixture(client);
        const runId = createSafeId<"legalListVerificationRun">();
        const claimId = createSafeId<"legalListClaim">();
        try {
          await client`INSERT INTO legal_list_verification_runs (id, organization_id, workspace_id,
            entity_id, file_field_id, entity_version_id, content_sha256, evidence)
            VALUES (${runId}, ${fixture.organizationId}, ${fixture.workspaceB}, ${fixture.factB},
              ${fixture.fieldB}, ${fixture.factVersionB}, repeat('a', 64), '{"facts":[],"listId":"fixture-list"}'::jsonb)`;
          await client`INSERT INTO legal_list_claims (id, workspace_id, run_id, position, type, state, text, anchor)
            VALUES (${claimId}, ${fixture.workspaceB}, ${runId}, 0, 'fact', 'nocover', 'Pinned claim',
              '{"type":"docx-block"}'::jsonb)`;
          const [before] =
            await client`SELECT xmin::text AS revision, entity_feature_gate AS gate
            FROM legal_list_claims WHERE id = ${claimId}`;
          expect(before?.gate).toBe("legal-lists");
          await client`UPDATE entities SET name = 'Renamed without a gate change' WHERE id = ${fixture.factB}`;
          expect(
            (
              await client`SELECT name FROM entities WHERE id = ${fixture.factB}`
            ).at(0)?.name,
          ).toBe("Renamed without a gate change");
          const [after] =
            await client`SELECT xmin::text AS revision, entity_feature_gate AS gate
            FROM legal_list_claims WHERE id = ${claimId}`;
          expect(after).toEqual(before);
        } finally {
          await client`DELETE FROM organization WHERE id = ${fixture.organizationId}`;
        }
      });
    }, 20_000);

    test("parent deletion clears the child ref; racing inserts receive the new gate", async () => {
      if (!databaseUrl) {
        panic("DATABASE_URL required");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const observer = openClient().sql;
        const fixture = await seedGateFixture(observer);
        const missingRunId = createSafeId<"flowRun">();
        const missingStepId = createSafeId<"flowRunStep">();
        const deleteRunId = createSafeId<"flowRun">();
        const deleteStepId = createSafeId<"flowRunStep">();
        const repairRunId = createSafeId<"flowRun">();
        const repairStepId = createSafeId<"flowRunStep">();
        const repairEntityId = createSafeId<"entity">();
        const raceVersionId = createSafeId<"entityVersion">();
        try {
          await observer`INSERT INTO flow_runs (id, workspace_id, definition_snapshot, trigger_source)
          VALUES (${missingRunId}, ${fixture.workspaceA}, '{}'::jsonb, '{}'::jsonb)`;
          await observer`INSERT INTO flow_run_steps (id, workspace_id, run_id, index, kind)
          VALUES (${missingStepId}, ${fixture.workspaceA}, ${missingRunId}, 0, 'review-gate')`;
          const nonexistentParentId = createSafeId<"entity">();
          const missingParentError = await rejectionOf(
            (async () =>
              await observer`UPDATE flow_run_steps
                SET review_task_entity_id = ${nonexistentParentId}
                WHERE id = ${missingStepId}`)(),
          );
          expect(getPgErrorCode(missingParentError)).toBe(
            PG_ERROR.FOREIGN_KEY_VIOLATION,
          );
          expect(missingParentError).toMatchObject({
            constraint: "flow_run_steps_review_task_entity_id_entities_id_fk",
          });
          const unchangedStep =
            await observer`SELECT review_task_entity_id, entity_feature_gate AS gate
              FROM flow_run_steps WHERE id = ${missingStepId}`;
          expect(unchangedStep).toEqual([
            { review_task_entity_id: null, gate: "open" },
          ]);
          await observer`UPDATE entities SET list_item_type = 'fact' WHERE id = ${fixture.factA}`;
          await observer`INSERT INTO flow_runs (id, workspace_id, definition_snapshot, trigger_source)
          VALUES (${deleteRunId}, ${fixture.workspaceA}, '{}'::jsonb, '{}'::jsonb)`;
          await observer`INSERT INTO flow_run_steps (id, workspace_id, run_id, index, kind, review_task_entity_id)
          VALUES (${deleteStepId}, ${fixture.workspaceA}, ${deleteRunId}, 0, 'review-gate', ${fixture.factA})`;
          expect(
            (
              await observer`SELECT entity_feature_gate AS gate FROM flow_run_steps WHERE id = ${deleteStepId}`
            ).at(0)?.gate,
          ).toBe("legal-lists");
          await observer`DELETE FROM entities WHERE id = ${fixture.factA}`;
          const clearedStep =
            await observer`SELECT review_task_entity_id, entity_feature_gate AS gate FROM flow_run_steps WHERE id = ${deleteStepId}`;
          expect(clearedStep).toEqual([
            { review_task_entity_id: null, gate: "open" },
          ]);
          await observer`INSERT INTO flow_runs (id, workspace_id, definition_snapshot, trigger_source)
          VALUES (${repairRunId}, ${fixture.workspaceA}, '{}'::jsonb, '{}'::jsonb)`;
          const repairChildWriter = openClient({ max: 1 }).sql;
          const parentInsertWriter = openClient({ max: 1 }).sql;
          const parentInserted = Promise.withResolvers<undefined>();
          const commitParent = Promise.withResolvers<undefined>();
          const insertParent = parentInsertWriter.begin(async (tx) => {
            await tx`INSERT INTO entities (id, workspace_id, kind, list_item_type, name)
              VALUES (${repairEntityId}, ${fixture.workspaceA}, 'task', 'fact', 'Concurrent parent')`;
            parentInserted.resolve(undefined);
            await commitParent.promise;
          });
          let repairInsert: Promise<unknown> | undefined;
          try {
            await Promise.race([
              parentInserted.promise,
              insertParent.then(() =>
                panic("Parent transaction completed before its insert signal"),
              ),
              Bun.sleep(3000).then(() =>
                panic("Parent transaction insert rendezvous timed out"),
              ),
            ]);
            repairInsert = repairChildWriter.begin(async (tx) => {
              await tx`INSERT INTO flow_run_steps (id, workspace_id, run_id, index, kind, review_task_entity_id)
                VALUES (${repairStepId}, ${fixture.workspaceA}, ${repairRunId}, 0, 'review-gate', ${repairEntityId})`;
            });
            const uncommittedParentError = await rejectionOf(repairInsert);
            repairInsert = undefined;
            expect(getPgErrorCode(uncommittedParentError)).toBe(
              PG_ERROR.FOREIGN_KEY_VIOLATION,
            );
            expect(uncommittedParentError).toMatchObject({
              constraint: "flow_run_steps_review_task_entity_id_entities_id_fk",
            });
            const pendingStep =
              await observer`SELECT id FROM flow_run_steps WHERE id = ${repairStepId}`;
            expect(pendingStep).toEqual([]);
            commitParent.resolve(undefined);
            await insertParent;
            await repairChildWriter.begin(
              async (tx) =>
                await tx`INSERT INTO flow_run_steps (id, workspace_id, run_id, index, kind, review_task_entity_id)
                VALUES (${repairStepId}, ${fixture.workspaceA}, ${repairRunId}, 0, 'review-gate', ${repairEntityId})`,
            );
          } finally {
            commitParent.resolve(undefined);
            await Promise.allSettled([
              insertParent,
              ...(repairInsert === undefined ? [] : [repairInsert]),
            ]);
          }
          expect(
            (
              await observer`SELECT entity_feature_gate AS gate FROM flow_run_steps WHERE id = ${repairStepId}`
            ).at(0)?.gate,
          ).toBe("legal-lists");
          const childWriter = openClient({ max: 1 }).sql;
          const parentWriter = openClient({ max: 1 }).sql;
          const locked = Promise.withResolvers<undefined>();
          const release = Promise.withResolvers<undefined>();
          const insertChild = childWriter.begin(async (tx) => {
            await tx`INSERT INTO entity_versions (id, workspace_id, entity_id, version_number)
            VALUES (${raceVersionId}, ${fixture.workspaceA}, ${fixture.taskA}, 2)`;
            locked.resolve(undefined);
            await release.promise;
          });
          let updateParent: Promise<unknown> | undefined;
          try {
            await Promise.race([
              locked.promise,
              insertChild.then(() =>
                panic("Child transaction completed before its lock signal"),
              ),
              Bun.sleep(3000).then(() =>
                panic("Child transaction insert rendezvous timed out"),
              ),
            ]);
            const pid = await backendPid(parentWriter);
            updateParent = parentWriter.begin(
              async (tx) =>
                await tx`UPDATE entities SET list_item_type = 'fact' WHERE id = ${fixture.taskA}`,
            );
            await waitUntilBlocked(observer, pid);
            release.resolve(undefined);
            await Promise.all([insertChild, updateParent]);
            expect(
              (await gateOf(observer, "entity_versions", raceVersionId)).at(0)
                ?.gate,
            ).toBe("legal-lists");
          } finally {
            release.resolve(undefined);
            await Promise.allSettled([
              insertChild,
              ...(updateParent === undefined ? [] : [updateParent]),
            ]);
          }
        } finally {
          await observer`DELETE FROM organization WHERE id = ${fixture.organizationId}`;
        }
      });
    }, 20_000);
  },
);
