import { panic } from "better-result";
import { eq, like, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as v from "valibot";

import type { Transaction } from "@/api/db/root";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import { executedRows } from "@/api/lib/db/executed-rows";
import { escapeLike } from "@/api/lib/escape-like";
import { flowDefinitionInputSchema } from "@/api/lib/flows/flow-types";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { withOrgScopedFixture } from "@/api/tests/helpers/org-scoped-fixture";
import {
  RECOVERY_COHORT_SETUP,
  type RecoveryScenario,
} from "@/api/tests/query-perf/registry";

export const RECOVERY_ORGANIZATION_PREFIX = "query-perf-recovery";
export const RECOVERY_USER_PREFIX = `${RECOVERY_ORGANIZATION_PREFIX}-user`;
const NOW = new Date("2026-01-10T12:00:00.000Z");
const LATER = new Date("2026-01-10T12:10:00.000Z");
const CHUNK_ROWS = 20_000;
const CLEANUP_BATCH_ROWS = 1000;
const RECOVERY_DIMENSION_PREFIX = "query-perf-dimension";

const seedRecoveryDimensionPadding = async (
  database: GatedTestDb,
  { job, cohort, rows }: RecoveryScenario,
) => {
  const dimensionRows = Math.max(512, Math.ceil(rows / 12));
  const dimensionUserPrefix = `${RECOVERY_DIMENSION_PREFIX}-user-${job}-${cohort}-`;
  const dimensionOrganizationPrefix = `${RECOVERY_DIMENSION_PREFIX}-org-${job}-${cohort}-`;
  const dimensionMemberPrefix = `${RECOVERY_DIMENSION_PREFIX}-member-${job}-${cohort}-`;
  const dimensionWorkspacePrefix = `${RECOVERY_DIMENSION_PREFIX}-workspace-${job}-${cohort}-`;
  const dimensionWorkspaceMemberPrefix = `${RECOVERY_DIMENSION_PREFIX}-workspace-member-${job}-${cohort}-`;
  const dimensionFlowPrefix = `${RECOVERY_DIMENSION_PREFIX}-flow-${job}-${cohort}-`;
  const dimensionSchedulerPrefix = `${RECOVERY_DIMENSION_PREFIX}-scheduler-${job}-${cohort}-`;

  await database.execute(sql`INSERT INTO organization (id, name, slug, created_at)
    SELECT ${dimensionOrganizationPrefix} || n,
      'Recovery query plan dimension', ${dimensionOrganizationPrefix} || n,
      ${NOW}
    FROM generate_series(1, ${dimensionRows}) AS series(n)`);
  await database.execute(sql`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    SELECT ${dimensionUserPrefix} || n, 'Recovery query plan dimension',
      ${dimensionUserPrefix} || n || '@example.test', true, ${NOW}, ${NOW}
    FROM generate_series(1, ${dimensionRows}) AS series(n)`);
  await database.execute(sql`INSERT INTO member (id, organization_id, user_id, role, created_at)
    SELECT ${dimensionMemberPrefix} || n,
      ${dimensionOrganizationPrefix} || n, ${dimensionUserPrefix} || n,
      'member', ${NOW}
    FROM generate_series(1, ${dimensionRows}) AS series(n)`);
  await database.execute(sql`INSERT INTO workspaces (id, organization_id, name, reference)
    SELECT md5(${dimensionWorkspacePrefix} || n)::uuid,
      ${dimensionOrganizationPrefix} || n, 'Recovery query plan dimension', 'dimension-' || n
    FROM generate_series(1, ${dimensionRows}) AS series(n)`);
  await database.execute(sql`INSERT INTO workspace_members (id, workspace_id, user_id)
    SELECT md5(${dimensionWorkspaceMemberPrefix} || n)::uuid,
      md5(${dimensionWorkspacePrefix} || n)::uuid,
      ${dimensionUserPrefix} || n
    FROM generate_series(1, ${dimensionRows}) AS series(n)`);
  await database.execute(sql`INSERT INTO feature_enrolments (organization_id, user_id, feature_id, created_at)
    SELECT ${dimensionOrganizationPrefix} || n, ${dimensionUserPrefix} || n,
      ${job === "upload" ? "flows" : "signals"}, ${NOW}
    FROM generate_series(1, ${dimensionRows}) AS series(n)`);

  if (job === "upload") {
    const steps = v.parse(flowDefinitionInputSchema.entries.steps, [
      {
        kind: "review-gate",
        name: "Review source",
        instructions: "Review the source.",
      },
    ]);
    await database.execute(sql`INSERT INTO flow_definitions
      (id, organization_id, name, steps, trigger, enabled, created_by_user_id, created_at, updated_at)
      SELECT md5(${dimensionFlowPrefix} || n)::uuid,
        ${dimensionOrganizationPrefix} || n, 'Recovery query plan dimension',
        ${JSON.stringify(steps)}::text::jsonb, '{"type":"manual"}'::jsonb, false,
        ${dimensionUserPrefix} || n, ${NOW}, ${NOW}
      FROM generate_series(1, ${dimensionRows}) AS series(n)`);
    await database.execute(sql`INSERT INTO flow_runs
      (id, workspace_id, definition_id, definition_snapshot, status, trigger_source, started_at, finished_at, created_at)
      SELECT md5(${dimensionFlowPrefix} || 'run-' || n)::uuid,
        md5(${dimensionWorkspacePrefix} || n)::uuid,
        md5(${dimensionFlowPrefix} || n)::uuid,
        jsonb_build_object('name', 'Recovery query plan dimension', 'steps', ${JSON.stringify(steps)}::text::jsonb),
        'completed', jsonb_build_object('type', 'manual', 'userId', ${dimensionUserPrefix} || n),
        ${NOW}, ${NOW}, ${NOW}
      FROM generate_series(1, ${dimensionRows}) AS series(n)`);
  }

  await database.execute(sql`INSERT INTO scheduler_jobs
    (id, task, description, schedule, enabled, next_run_at, created_at, updated_at)
    SELECT ${dimensionSchedulerPrefix} || n,
      'query-perf.background-padding', 'Disabled query plan fixture row',
      '{"type":"interval","everyMs":300000}'::jsonb, false, ${NOW}, ${NOW}, ${NOW}
    FROM generate_series(1, ${dimensionRows}) AS series(n)`);
};

/** Three organizations, four matters apiece, with live owners and source rows. */
export const seedRecoveryScenario = async (
  database: GatedTestDb,
  { job, cohort, rows }: RecoveryScenario,
) => {
  await seedRecoveryDimensionPadding(database, { job, cohort, rows });
  await database.execute(sql`INSERT INTO organization (id, name, slug, created_at)
    SELECT ${RECOVERY_ORGANIZATION_PREFIX} || '-' || ${job} || '-' || ${cohort} || '-' || n,
      'Recovery measurement', ${RECOVERY_ORGANIZATION_PREFIX} || '-' || ${job} || '-' || ${cohort} || '-' || n,
      ${NOW}
    FROM generate_series(1, 3) AS n`);
  await database.execute(sql`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    SELECT ${RECOVERY_USER_PREFIX} || '-' || ${job} || '-' || ${cohort} || '-' || n,
      'Recovery measurement', ${RECOVERY_USER_PREFIX} || '-' || ${job} || '-' || ${cohort} || '-' || n || '@example.test',
      true, ${NOW}, ${NOW}
    FROM generate_series(1, 3) AS n`);
  await database.execute(sql`INSERT INTO member (id, organization_id, user_id, role, created_at)
    SELECT 'query-perf-recovery-member-' || ${job} || '-' || ${cohort} || '-' || n,
      ${RECOVERY_ORGANIZATION_PREFIX} || '-' || ${job} || '-' || ${cohort} || '-' || n,
      ${RECOVERY_USER_PREFIX} || '-' || ${job} || '-' || ${cohort} || '-' || n,
      'member', ${NOW}
    FROM generate_series(1, 3) AS n`);
  await database.execute(sql`INSERT INTO workspaces (id, organization_id, name, reference)
    SELECT md5('recovery-workspace-' || ${job} || '-' || ${cohort} || '-' || org.n || '-' || matter.n)::uuid,
      ${RECOVERY_ORGANIZATION_PREFIX} || '-' || ${job} || '-' || ${cohort} || '-' || org.n,
      'Recovery matter ' || matter.n, 'recovery-' || matter.n
    FROM generate_series(1, 3) AS org(n) CROSS JOIN generate_series(1, 4) AS matter(n)`);
  await database.execute(sql`INSERT INTO workspace_members (id, workspace_id, user_id)
    SELECT md5('recovery-workspace-member-' || ${job} || '-' || ${cohort} || '-' || org.n || '-' || matter.n)::uuid,
      md5('recovery-workspace-' || ${job} || '-' || ${cohort} || '-' || org.n || '-' || matter.n)::uuid,
      ${RECOVERY_USER_PREFIX} || '-' || ${job} || '-' || ${cohort} || '-' || org.n
    FROM generate_series(1, 3) AS org(n) CROSS JOIN generate_series(1, 4) AS matter(n)`);
  const { enrolled, initialStatus } = RECOVERY_COHORT_SETUP[cohort];
  if (enrolled) {
    await database.execute(sql`INSERT INTO feature_enrolments (organization_id, user_id, feature_id, created_at)
      SELECT ${RECOVERY_ORGANIZATION_PREFIX} || '-' || ${job} || '-' || ${cohort} || '-' || n,
        ${RECOVERY_USER_PREFIX} || '-' || ${job} || '-' || ${cohort} || '-' || n,
        ${job === "upload" ? "flows" : "signals"}, ${NOW}
      FROM generate_series(1, 3) AS outer_org(n)`);
  }

  if (job === "upload") {
    const steps = v.parse(flowDefinitionInputSchema.entries.steps, [
      {
        kind: "review-gate",
        name: "Review source",
        instructions: "Review the source.",
      },
    ]);
    await database.execute(sql`INSERT INTO flow_definitions
      (id, organization_id, name, steps, trigger, enabled, created_by_user_id, created_at, updated_at)
      SELECT md5('recovery-flow-' || ${job} || '-' || ${cohort} || '-' || n)::uuid,
        ${RECOVERY_ORGANIZATION_PREFIX} || '-' || ${job} || '-' || ${cohort} || '-' || n,
        'Recovery flow', ${JSON.stringify(steps)}::text::jsonb,
        jsonb_build_object('type', 'file-upload', 'workspaceIds', (
          SELECT jsonb_agg(md5('recovery-workspace-' || ${job} || '-' || ${cohort} || '-' || outer_org.n || '-' || matter.matter_index)::uuid)
          FROM generate_series(1, 4) AS matter(matter_index)
        ), 'fileExtensions', jsonb_build_array('pdf')),
        true, ${RECOVERY_USER_PREFIX} || '-' || ${job} || '-' || ${cohort} || '-' || n, ${NOW}, ${NOW}
      FROM generate_series(1, 3) AS outer_org(n)`);
  }

  const matters = await database
    .select({
      id: workspaces.id,
      organizationId: workspaces.organizationId,
      userId: workspaceMembers.userId,
    })
    .from(workspaces)
    .innerJoin(
      workspaceMembers,
      eq(workspaceMembers.workspaceId, workspaces.id),
    )
    .where(
      like(
        workspaces.organizationId,
        `${escapeLike(`${RECOVERY_ORGANIZATION_PREFIX}-${job}-${cohort}-`)}%`,
      ),
    );
  if (matters.length !== 12) {
    panic(`Expected 12 persisted recovery matters, found ${matters.length}`);
  }

  for (let first = 1; first <= rows; first += CHUNK_ROWS) {
    const last = Math.min(first + CHUNK_ROWS - 1, rows);
    for (const matter of matters) {
      await withOrgScopedFixture({
        database,
        workspaceId: matter.id,
        actor: { type: "actor", userId: matter.userId },
        fn: async (tx) => {
          await tx.execute(sql`INSERT INTO entities (id, workspace_id, kind, name, created_by)
            SELECT md5('recovery-entity-' || ${job} || '-' || ${cohort} || '-' || i)::uuid,
              ${matter.id}, 'document', 'Recovery source ' || i, ${matter.userId}
            FROM generate_series(${first}::integer, ${last}::integer) AS series(i)
            WHERE md5('recovery-workspace-' || ${job} || '-' || ${cohort} || '-' || ((i - 1) % 3 + 1) || '-' || ((i - 1) % 4 + 1))::uuid = ${matter.id}
              AND ${RECOVERY_ORGANIZATION_PREFIX} || '-' || ${job} || '-' || ${cohort} || '-' || ((i - 1) % 3 + 1) = ${matter.organizationId}`);
          if (job === "scout") {
            await tx.execute(sql`INSERT INTO entity_versions
              (id, workspace_id, entity_id, version_number, created_by)
              SELECT md5('recovery-version-' || ${job} || '-' || ${cohort} || '-' || i)::uuid,
                ${matter.id},
                md5('recovery-entity-' || ${job} || '-' || ${cohort} || '-' || i)::uuid,
                1, ${matter.userId}
              FROM generate_series(${first}::integer, ${last}::integer) AS series(i)
              WHERE md5('recovery-workspace-' || ${job} || '-' || ${cohort} || '-' || ((i - 1) % 3 + 1) || '-' || ((i - 1) % 4 + 1))::uuid = ${matter.id}
                AND ${RECOVERY_ORGANIZATION_PREFIX} || '-' || ${job} || '-' || ${cohort} || '-' || ((i - 1) % 3 + 1) = ${matter.organizationId}`);
            await tx.execute(sql`INSERT INTO properties
              (id, workspace_id, name, status, content, tool)
              SELECT md5('recovery-property-' || ${job} || '-' || ${cohort} || '-' || ${first} || '-' || ${matter.id}::text)::uuid,
                ${matter.id}, 'Recovery source file', 'fresh',
                '{"type":"file","version":1}'::jsonb,
                '{"type":"manual-input","version":1}'::jsonb
              WHERE EXISTS (SELECT 1 FROM workspaces
                WHERE id = ${matter.id} AND organization_id = ${matter.organizationId})`);
            await tx.execute(sql`INSERT INTO fields
              (id, workspace_id, property_id, entity_version_id, content)
              SELECT md5('recovery-file-field-' || ${job} || '-' || ${cohort} || '-' || i)::uuid,
                ${matter.id},
                md5('recovery-property-' || ${job} || '-' || ${cohort} || '-' || ${first} || '-' || ${matter.id}::text)::uuid,
                md5('recovery-version-' || ${job} || '-' || ${cohort} || '-' || i)::uuid,
                '{"type":"pending","version":1}'::jsonb
              FROM generate_series(${first}::integer, ${last}::integer) AS series(i)
              WHERE md5('recovery-workspace-' || ${job} || '-' || ${cohort} || '-' || ((i - 1) % 3 + 1) || '-' || ((i - 1) % 4 + 1))::uuid = ${matter.id}
                AND ${RECOVERY_ORGANIZATION_PREFIX} || '-' || ${job} || '-' || ${cohort} || '-' || ((i - 1) % 3 + 1) = ${matter.organizationId}`);
            await tx.execute(sql`INSERT INTO document_review_runs
              (id, organization_id, workspace_id, entity_id, file_field_id, entity_version_id,
               content_sha256, basis, status, total, completed, requested_by, created_at)
              SELECT md5('recovery-review-' || ${job} || '-' || ${cohort} || '-' || i)::uuid,
                ${matter.organizationId}, ${matter.id},
                md5('recovery-entity-' || ${job} || '-' || ${cohort} || '-' || i)::uuid,
                md5('recovery-file-field-' || ${job} || '-' || ${cohort} || '-' || i)::uuid,
                md5('recovery-version-' || ${job} || '-' || ${cohort} || '-' || i)::uuid,
                repeat('a', 64),
                '{"playbook":{"definitionId":null,"versionId":null,"provenance":"ephemeral","definitionSnapshot":{"name":"Perf fixture","positions":{"version":3,"items":[]}}},"references":[],"perspective":{"type":"neutral"}}'::jsonb,
                'completed', 1, 1, ${matter.userId}, ${NOW}
              FROM generate_series(${first}::integer, ${last}::integer) AS series(i)
              WHERE md5('recovery-workspace-' || ${job} || '-' || ${cohort} || '-' || ((i - 1) % 3 + 1) || '-' || ((i - 1) % 4 + 1))::uuid = ${matter.id}
                AND ${RECOVERY_ORGANIZATION_PREFIX} || '-' || ${job} || '-' || ${cohort} || '-' || ((i - 1) % 3 + 1) = ${matter.organizationId}`);
            await tx.execute(sql`INSERT INTO document_review_findings
              (id, organization_id, workspace_id, run_id, entity_id, file_field_id,
               entity_version_id, position_id, position_title, outcome, payload)
              SELECT md5('recovery-finding-' || ${job} || '-' || ${cohort} || '-' || i)::uuid,
                ${matter.organizationId}, ${matter.id},
                md5('recovery-review-' || ${job} || '-' || ${cohort} || '-' || i)::uuid,
                md5('recovery-entity-' || ${job} || '-' || ${cohort} || '-' || i)::uuid,
                md5('recovery-file-field-' || ${job} || '-' || ${cohort} || '-' || i)::uuid,
                md5('recovery-version-' || ${job} || '-' || ${cohort} || '-' || i)::uuid,
                md5('recovery-position-' || ${job} || '-' || ${cohort} || '-' || i)::uuid,
                'Governing law', 'deviation',
                jsonb_build_object('finding', jsonb_build_object(
                  'positionId', md5('recovery-position-' || ${job} || '-' || ${cohort} || '-' || i)::uuid,
                  'issue', 'Governing law', 'severity', 'medium', 'standardSource', 'tiers',
                  'verdict', 'deviation', 'delta', jsonb_build_object('kind', 'language'),
                  'extracted', null, 'rationale', 'Differs from the playbook',
                  'citations', '[]'::jsonb, 'fix', null))
              FROM generate_series(${first}::integer, ${last}::integer) AS series(i)
              WHERE md5('recovery-workspace-' || ${job} || '-' || ${cohort} || '-' || ((i - 1) % 3 + 1) || '-' || ((i - 1) % 4 + 1))::uuid = ${matter.id}
                AND ${RECOVERY_ORGANIZATION_PREFIX} || '-' || ${job} || '-' || ${cohort} || '-' || ((i - 1) % 3 + 1) = ${matter.organizationId}`);
          }
        },
      });

      await withOrgScopedFixture({
        database,
        workspaceId: matter.id,
        actor: { type: "system" },
        fn: async (tx) => {
          if (job === "upload") {
            await tx.execute(sql`INSERT INTO flow_upload_trigger_intents
              (definition_id, entity_id, workspace_id, organization_id, file_extension, status, retry_at, created_at)
              SELECT md5('recovery-flow-' || ${job} || '-' || ${cohort} || '-' || ((i - 1) % 3 + 1))::uuid,
                md5('recovery-entity-' || ${job} || '-' || ${cohort} || '-' || i)::uuid,
                ${matter.id}, ${matter.organizationId}, 'pdf',
                ${initialStatus},
                ${cohort === "quiet" ? LATER : NOW}, ${NOW}
              FROM generate_series(${first}::integer, ${last}::integer) AS series(i)
              WHERE md5('recovery-workspace-' || ${job} || '-' || ${cohort} || '-' || ((i - 1) % 3 + 1) || '-' || ((i - 1) % 4 + 1))::uuid = ${matter.id}
                AND ${RECOVERY_ORGANIZATION_PREFIX} || '-' || ${job} || '-' || ${cohort} || '-' || ((i - 1) % 3 + 1) = ${matter.organizationId}`);
            return;
          }
          await tx.execute(sql`INSERT INTO pending_scout_emissions
            (organization_id, workspace_id, source_kind, source_id, status, next_attempt_at, created_at)
            SELECT ${matter.organizationId}, ${matter.id}, 'document-review',
              md5('recovery-review-' || ${job} || '-' || ${cohort} || '-' || i)::uuid,
              ${initialStatus},
              ${cohort === "quiet" ? LATER : NOW}, ${NOW}
            FROM generate_series(${first}::integer, ${last}::integer) AS series(i)
            WHERE md5('recovery-workspace-' || ${job} || '-' || ${cohort} || '-' || ((i - 1) % 3 + 1) || '-' || ((i - 1) % 4 + 1))::uuid = ${matter.id}
              AND ${RECOVERY_ORGANIZATION_PREFIX} || '-' || ${job} || '-' || ${cohort} || '-' || ((i - 1) % 3 + 1) = ${matter.organizationId}`);
        },
      });
    }
  }

  const tables =
    job === "upload"
      ? [
          "scheduler_jobs",
          "feature_enrolments",
          "workspace_members",
          "workspaces",
          "member",
          '"user"',
          "organization",
          "flow_upload_trigger_intents",
          "flow_definitions",
          "flow_runs",
          "entities",
        ]
      : [
          "scheduler_jobs",
          "feature_enrolments",
          "workspace_members",
          "workspaces",
          "member",
          '"user"',
          "organization",
          "pending_scout_emissions",
          "document_review_findings",
          "document_review_runs",
          "entities",
        ];
  for (const table of tables) {
    await database.execute(sql.raw(`VACUUM (ANALYZE) ${table}`));
  }
  return { job, cohort, rows, now: NOW } as const;
};

type RecoveryCleanupTable =
  | "document_review_findings"
  | "document_review_runs"
  | "entities"
  | "entity_versions"
  | "fields"
  | "flow_definitions"
  | "flow_upload_trigger_intents"
  | "pending_scout_emissions"
  | "properties";

type DeleteRecoveryBatchOptions = {
  tx: Transaction;
  table: RecoveryCleanupTable;
  scopeColumn: "organization_id" | "workspace_id";
  scopeId: string;
  where: SQL;
};

const deleteRecoveryBatch = async ({
  tx,
  table,
  scopeColumn,
  scopeId,
  where,
}: DeleteRecoveryBatchOptions) =>
  executedRows(
    await tx.execute(sql`WITH batch AS (
      SELECT candidate.ctid
      FROM ${sql.identifier(table)} AS candidate
      WHERE candidate.${sql.identifier(scopeColumn)} = ${scopeId}
        AND ${where}
      ORDER BY candidate.ctid
      LIMIT ${CLEANUP_BATCH_ROWS}
    )
    DELETE FROM ${sql.identifier(table)} AS target
    USING batch
    WHERE target.ctid = batch.ctid
    RETURNING 1`),
  ).length;

const deleteRecoveryTable = async (
  options: DeleteRecoveryBatchOptions,
): Promise<number> => {
  let deleted = 0;
  while (true) {
    const batch = await deleteRecoveryBatch(options);
    deleted += batch;
    if (batch < CLEANUP_BATCH_ROWS) {
      return deleted;
    }
  }
};

const addCleanupCount = (
  counts: Map<string, number>,
  table: string,
  deleted: number,
) => counts.set(table, (counts.get(table) ?? 0) + deleted);

export const cleanupRecoveryScenarios = async (
  database: GatedTestDb,
): Promise<Map<string, number>> => {
  const counts = new Map<string, number>();
  const matters = await database
    .select({
      id: workspaces.id,
      organizationId: workspaces.organizationId,
      userId: workspaceMembers.userId,
    })
    .from(workspaces)
    .innerJoin(
      workspaceMembers,
      eq(workspaceMembers.workspaceId, workspaces.id),
    )
    .where(
      like(
        workspaces.organizationId,
        `${escapeLike(RECOVERY_ORGANIZATION_PREFIX)}-%`,
      ),
    );
  for (const matter of matters) {
    await withOrgScopedFixture({
      database,
      workspaceId: matter.id,
      actor: { type: "actor", userId: matter.userId },
      fn: async (tx) => {
        for (const [table, where] of [
          [
            "document_review_findings",
            sql`organization_id = ${matter.organizationId}`,
          ],
          [
            "document_review_runs",
            sql`organization_id = ${matter.organizationId}`,
          ],
          ["fields", sql`content->>'type' = 'pending'`],
          ["entity_versions", sql`created_by = ${matter.userId}`],
          [
            "entities",
            sql`created_by = ${matter.userId} AND name LIKE 'Recovery source %'`,
          ],
          ["properties", sql`name = 'Recovery source file'`],
        ] as const) {
          addCleanupCount(
            counts,
            table,
            await deleteRecoveryTable({
              tx,
              table,
              scopeColumn: "workspace_id",
              scopeId: matter.id,
              where,
            }),
          );
        }
      },
    });
    await withOrgScopedFixture({
      database,
      workspaceId: matter.id,
      actor: { type: "system" },
      fn: async (tx) => {
        for (const table of [
          "flow_upload_trigger_intents",
          "pending_scout_emissions",
        ] as const) {
          addCleanupCount(
            counts,
            table,
            await deleteRecoveryTable({
              tx,
              table,
              scopeColumn: "workspace_id",
              scopeId: matter.id,
              where: sql`organization_id = ${matter.organizationId}`,
            }),
          );
        }
      },
    });
  }

  for (const organizationId of new Set(
    matters.map((matter) => matter.organizationId),
  )) {
    const matter = matters.find(
      (candidate) => candidate.organizationId === organizationId,
    );
    if (matter === undefined) {
      panic("Recovery cleanup organization must have a persisted matter");
    }
    await withOrgScopedFixture({
      database,
      workspaceId: matter.id,
      actor: { type: "system" },
      fn: async (tx) =>
        addCleanupCount(
          counts,
          "flow_definitions",
          await deleteRecoveryTable({
            tx,
            table: "flow_definitions",
            scopeColumn: "organization_id",
            scopeId: organizationId,
            where: sql`name = 'Recovery flow'`,
          }),
        ),
    });
  }

  addCleanupCount(
    counts,
    "organizations",
    executedRows(
      await database.execute(sql`DELETE FROM organization
        WHERE id LIKE ${`${escapeLike(RECOVERY_ORGANIZATION_PREFIX)}-%`}
        RETURNING 1`),
    ).length,
  );
  addCleanupCount(
    counts,
    "users",
    executedRows(
      await database.execute(sql`DELETE FROM "user"
        WHERE id LIKE ${`${escapeLike(RECOVERY_USER_PREFIX)}-%`}
        RETURNING 1`),
    ).length,
  );
  return counts;
};
