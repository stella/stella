import { expect, test } from "bun:test";

import { createTestPglite } from "@/api/tests/pglite-test-db";

import { createDocumentDerivativeRunOwnershipRepairs } from "./document-derivative-run-ownership-repair";
import { createUngatedTableGateForTests } from "./online-ddl";
import type { OnlineMigrationConnection } from "./online-migration-connection";

const [BILINGUAL_REPAIR, REVIEW_REPAIR] =
  createDocumentDerivativeRunOwnershipRepairs({
    sleep: async () => {},
    log: () => {},
    readVerdict: async () => ({
      kind: "normal",
      signals: [
        {
          indicator: "ebs_balance",
          kind: "normal",
          value: 90,
          threshold: 70,
          observedAt: "2026-10-25T08:00:00.000Z",
          reason: "Injected health for repair semantics",
        },
      ],
    }),
  });

type PgliteClient = Awaited<ReturnType<typeof createTestPglite>>;

const connectionOver = (client: PgliteClient): OnlineMigrationConnection => ({
  execute: async (query, params = []) => {
    await client.query(query, [...params]);
  },
  query: async (query, params = []) =>
    (await client.query(query, [...params])).rows,
  release: () => {},
});

const ORGANIZATION_ID = "org-run-ownership";
const WORKSPACE_ID = "6f1d2c3b-4a59-4e8f-9a7b-1c2d3e4f5a60";
const LIVE_ENTITY_ID = "6f1d2c3b-4a59-4e8f-9a7b-1c2d3e4f5a61";
/** More orphan runs than one batch, so the walk resumes across batches. */
const ORPHANS = 1203;
const LIVE_RUNS = 7;

const readRunEntities = async (client: PgliteClient) =>
  (
    await client.query<{ entity_id: string; rows: number }>(
      `SELECT run.entity_id::text AS entity_id, count(row.id)::int AS rows
         FROM bilingual_translation_runs run
         LEFT JOIN bilingual_translation_rows row ON row.run_id = run.id
        GROUP BY run.id, run.entity_id
        ORDER BY run.id`,
    )
  ).rows;

const insertRuns = async (
  client: PgliteClient,
  { entityId, count }: { entityId: string | null; count: number },
) => {
  // A null entity stands for a document permanently deleted before the key.
  await client.query(
    `INSERT INTO bilingual_translation_runs
       (id, organization_id, workspace_id, entity_id, file_field_id,
        entity_version_id, source_lang, target_lang, glossary, status, total,
        completed)
     SELECT gen_random_uuid(), $1, $2::uuid,
            coalesce($3::uuid, gen_random_uuid()), gen_random_uuid(),
            gen_random_uuid(), 'en', 'cs', '[]'::jsonb, 'completed', 1, 1
       FROM generate_series(1, $4::int)`,
    [ORGANIZATION_ID, WORKSPACE_ID, entityId, count],
  );
  await client.query(
    `INSERT INTO bilingual_translation_rows
       (id, organization_id, workspace_id, run_id, row_id, ordinal, kind,
        disposition, disposition_origin, source_text, target_text, status)
     SELECT gen_random_uuid(), run.organization_id, run.workspace_id, run.id,
            'paragraph-1', 0, 'paragraph', 'translate', 'user', 'Source',
            'Target', 'translated'
       FROM bilingual_translation_runs run
      WHERE NOT EXISTS (
        SELECT 1 FROM bilingual_translation_rows row WHERE row.run_id = run.id
      )`,
  );
};

const readReviewRunEntities = async (client: PgliteClient) =>
  (
    await client.query<{ entity_id: string; findings: number }>(
      `SELECT run.entity_id::text AS entity_id,
              count(finding.id)::int AS findings
         FROM document_review_runs run
         LEFT JOIN document_review_findings finding ON finding.run_id = run.id
        GROUP BY run.id, run.entity_id
        ORDER BY run.id`,
    )
  ).rows;

const insertReviewRuns = async (
  client: PgliteClient,
  { entityId, count }: { entityId: string | null; count: number },
) => {
  // A null entity stands for a document permanently deleted before the key.
  await client.query(
    `INSERT INTO document_review_runs
       (id, organization_id, workspace_id, entity_id, file_field_id,
        entity_version_id, content_sha256, basis, status, total, completed)
     SELECT gen_random_uuid(), $1, $2::uuid,
            coalesce($3::uuid, gen_random_uuid()), gen_random_uuid(),
            gen_random_uuid(), repeat('a', 64),
            '{"playbook":{"provenance":"ephemeral","definitionSnapshot":{"positions":{}}}}'::jsonb,
            'completed', 1, 1
       FROM generate_series(1, $4::int)`,
    [ORGANIZATION_ID, WORKSPACE_ID, entityId, count],
  );
  await client.query(
    `INSERT INTO document_review_findings
       (id, organization_id, workspace_id, run_id, entity_id, file_field_id,
        entity_version_id, position_id, position_title, payload)
     SELECT gen_random_uuid(), run.organization_id, run.workspace_id, run.id,
            run.entity_id, run.file_field_id, run.entity_version_id,
            gen_random_uuid(), 'Position', '{}'::jsonb
       FROM document_review_runs run
      WHERE NOT EXISTS (
        SELECT 1 FROM document_review_findings finding
         WHERE finding.run_id = run.id
      )`,
  );
};

test("erases only runs whose document is gone, validates the key, and converges", async () => {
  const client = await createTestPglite();
  const connection = connectionOver(client);
  await client.query(
    "INSERT INTO organization (id, name, slug, created_at) VALUES ($1, 'Firm', $1, now())",
    [ORGANIZATION_ID],
  );
  await client.query(
    "INSERT INTO workspaces (id, organization_id, name, reference) VALUES ($1, $2, 'Matter', 'matter-1')",
    [WORKSPACE_ID, ORGANIZATION_ID],
  );
  await client.query(
    "INSERT INTO entities (id, workspace_id, kind, name) VALUES ($1, $2, 'document', 'Kept')",
    [LIVE_ENTITY_ID, WORKSPACE_ID],
  );
  // The state migration 20261025090500 meets: runs of deleted documents exist
  // and the key arrives NOT VALID.
  for (const table of ["bilingual_translation_runs", "document_review_runs"]) {
    await client.query(
      `ALTER TABLE ${table} DROP CONSTRAINT ${table}_entity_workspace_fk`,
    );
  }
  await insertRuns(client, { entityId: LIVE_ENTITY_ID, count: LIVE_RUNS });
  await insertRuns(client, { entityId: null, count: ORPHANS });
  await insertReviewRuns(client, {
    entityId: LIVE_ENTITY_ID,
    count: LIVE_RUNS,
  });
  await insertReviewRuns(client, { entityId: null, count: ORPHANS });
  for (const table of ["bilingual_translation_runs", "document_review_runs"]) {
    await client.query(
      `ALTER TABLE ${table} ADD CONSTRAINT ${table}_entity_workspace_fk
         FOREIGN KEY (entity_id, workspace_id)
         REFERENCES entities (id, workspace_id) ON DELETE CASCADE NOT VALID`,
    );
  }
  const live = (await readRunEntities(client)).filter(
    ({ entity_id }) => entity_id === LIVE_ENTITY_ID,
  );
  expect(live).toHaveLength(LIVE_RUNS);
  const liveReviews = (await readReviewRunEntities(client)).filter(
    ({ entity_id }) => entity_id === LIVE_ENTITY_ID,
  );
  expect(liveReviews).toHaveLength(LIVE_RUNS);
  expect(await readReviewRunEntities(client)).toHaveLength(LIVE_RUNS + ORPHANS);

  for (const repair of [BILINGUAL_REPAIR, REVIEW_REPAIR]) {
    expect((await repair?.readCompletion(connection))?.type).toBe("incomplete");
    expect(
      await repair?.repair(
        connection,
        createUngatedTableGateForTests(connection),
      ),
    ).toEqual({ type: "complete" });
    expect((await repair?.readCompletion(connection))?.type).toBe("complete");
  }

  // Every run of the kept document survives with its rows; orphans and their
  // rows are gone.
  expect(await readRunEntities(client)).toEqual(live);
  expect(
    (
      await client.query<{ rows: number }>(
        "SELECT count(*)::int AS rows FROM bilingual_translation_rows",
      )
    ).rows,
  ).toEqual([{ rows: LIVE_RUNS }]);
  // The same holds for review runs and the findings they carry.
  expect(await readReviewRunEntities(client)).toEqual(liveReviews);
  expect(
    (
      await client.query<{ findings: number }>(
        "SELECT count(*)::int AS findings FROM document_review_findings",
      )
    ).rows,
  ).toEqual([{ findings: LIVE_RUNS }]);

  // A second run is a no-op.
  expect(
    await BILINGUAL_REPAIR?.repair(
      connection,
      createUngatedTableGateForTests(connection),
    ),
  ).toEqual({ type: "complete" });
  expect(await readRunEntities(client)).toEqual(live);
  expect(
    await REVIEW_REPAIR?.repair(
      connection,
      createUngatedTableGateForTests(connection),
    ),
  ).toEqual({ type: "complete" });
  expect(await readReviewRunEntities(client)).toEqual(liveReviews);
});
