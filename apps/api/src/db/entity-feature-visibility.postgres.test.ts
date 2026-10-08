import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { asc, count, eq, sql } from "drizzle-orm";

import { cents } from "@stll/money";
import { rejectionOf } from "@stll/property-testing/rejection";

import {
  entityContextId,
  entityContextReference,
} from "@/api/db/entity-feature-policies";
import {
  SETTING_ORGANIZATION_ID,
  SETTING_USER_ID,
  SETTING_WORKSPACE_IDS,
  SETTING_WORKSPACE_ACCESS_MODE,
  WORKSPACE_ACCESS_MODE,
} from "@/api/db/rls";
import {
  documentTranslationUnits,
  entities,
  entityVersions,
  legalListClaims,
  searchDocuments,
  timeEntries,
  workObligations,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import {
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import {
  WORK_OBLIGATION_CONTEXT_EXTRAS,
  WORK_OBLIGATION_EVENT_CONTEXT_EXTRAS,
} from "@/api/lib/work-obligations/read-context";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!runPostgresTests)(
  "entity feature visibility (postgres)",
  () => {
    for (const featureIds of [
      [],
      [LEGAL_LISTS_FEATURE_ID],
      [LEGAL_LISTS_FEATURE_ID, LIST_VERIFICATION_FEATURE_ID],
    ]) {
      test(`shared reads and ledger context with ${featureIds.length} grants`, async () => {
        if (!databaseUrl) {
          panic("DATABASE_URL required");
        }
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { sql: client, db } = openClient();
          const organizationId = mintAuthProviderId<"organization">();
          const userId = mintAuthProviderId<"user">();
          const workspaceId = createSafeId<"workspace">();
          const factId = createSafeId<"entity">();
          const taskId = createSafeId<"entity">();
          const versionId = createSafeId<"entityVersion">();
          const entryId = createSafeId<"timeEntry">();
          const eventId = createSafeId<"workObligationEvent">();
          const translationRunId = createSafeId<"documentTranslationRun">();
          const translationUnitId = createSafeId<"documentTranslationUnit">();
          const verificationRunId = createSafeId<"legalListVerificationRun">();
          const claimId = createSafeId<"legalListClaim">();
          const enabled = featureIds.includes(LEGAL_LISTS_FEATURE_ID);
          try {
            await client`INSERT INTO organization (id, name, slug, created_at)
            VALUES (${organizationId}, 'Feature organization', ${organizationId}, now())`;
            await client`INSERT INTO "user" (id, name, email)
            VALUES (${userId}, 'Feature user', ${`${userId}@example.test`})`;
            await client`INSERT INTO member (id, organization_id, user_id, role, created_at)
            VALUES (${mintAuthProviderIdValue()}, ${organizationId}, ${userId}, 'owner', now())`;
            await client`INSERT INTO workspaces (id, organization_id, name, reference)
            VALUES (${workspaceId}, ${organizationId}, 'Feature matter', ${workspaceId})`;
            await client`INSERT INTO entities (id, workspace_id, kind, list_item_type, name)
            VALUES (${factId}, ${workspaceId}, 'task', 'fact', 'Reference fact')`;
            await client`INSERT INTO entities (id, workspace_id, kind, list_item_type, name, parent_id)
            VALUES (${taskId}, ${workspaceId}, 'task', 'task', 'Ordinary task', ${factId})`;
            await client`INSERT INTO entity_versions (id, workspace_id, entity_id)
            VALUES (${versionId}, ${workspaceId}, ${factId})`;
            await client`INSERT INTO search_documents (entity_id, workspace_id, organization_id, kind, title, searchable_text)
            VALUES (${factId}, ${workspaceId}, ${organizationId}, 'task', 'Reference fact', 'Reference fact')`;
            await client`INSERT INTO time_entries (id, organization_id, workspace_id, user_id, work_item_id,
            date_worked, timezone_id, duration_minutes, billed_minutes, rate_at_entry, currency, narrative)
            VALUES (${entryId}, ${organizationId}, ${workspaceId}, ${userId}, ${factId},
              '2026-10-05', 'Europe/Prague', 60, 60, 12000, 'EUR', 'Recorded work')`;

            await client`INSERT INTO work_obligations (entity_id, workspace_id, source_entity_id, working_target_date)
            VALUES (${taskId}, ${workspaceId}, ${factId}, '2026-10-06')`;
            await client`INSERT INTO work_obligation_events (id, workspace_id, obligation_entity_id, type, details)
            VALUES (${eventId}, ${workspaceId}, ${taskId}, 'provenance_changed', ${JSON.stringify(
              {
                type: "provenance_changed",
                previousSourceType: "manual",
                nextSourceType: "document",
                previousSourceEntityId: factId,
                nextSourceEntityId: null,
              },
            )}::text::jsonb)`;

            // Dependent records hang off runs whose source is the hidden fact.
            await client`INSERT INTO document_translation_runs (id, organization_id, workspace_id, entity_id,
            file_field_id, entity_version_id, source_file_id, source_file_name, source_mime_type,
            output, engine, target_lang)
            VALUES (${translationRunId}, ${organizationId}, ${workspaceId}, ${factId},
              ${Bun.randomUUIDv7()}, ${versionId}, ${Bun.randomUUIDv7()}, 'fact.docx', 'text/plain',
              'translated', 'deepl', 'en')`;
            await client`INSERT INTO document_translation_units (id, organization_id, workspace_id, run_id,
            unit_key, ordinal, source_text, target_text, application)
            VALUES (${translationUnitId}, ${organizationId}, ${workspaceId}, ${translationRunId},
              'block-0', 0, 'Source text', 'Translated text', '{}'::jsonb)`;
            await client`INSERT INTO legal_list_verification_runs (id, organization_id, workspace_id, entity_id,
            file_field_id, entity_version_id, content_sha256, evidence)
            VALUES (${verificationRunId}, ${organizationId}, ${workspaceId}, ${factId},
              ${Bun.randomUUIDv7()}, ${versionId}, repeat('a', 64),
              '{"facts": [], "listId": "fixture_list"}'::jsonb)`;
            await client`INSERT INTO legal_list_claims (id, workspace_id, run_id, position, type, state, text, anchor)
            VALUES (${claimId}, ${workspaceId}, ${verificationRunId}, 0, 'fact', 'nocover',
              'Claim text', '{"type": "docx-block"}'::jsonb)`;

            await db.transaction(async (tx) => {
              await tx.execute(sql`SELECT set_config('role', 'stella', true),
              set_config(${SETTING_ORGANIZATION_ID}, ${organizationId}, true),
              set_config(${SETTING_USER_ID}, ${userId}, true),
              set_config(${SETTING_WORKSPACE_IDS}, ${`{${workspaceId}}`}, true),
              set_config(${SETTING_WORKSPACE_ACCESS_MODE}, ${WORKSPACE_ACCESS_MODE.explicit}, true),
              set_config('app.enabled_features', ${JSON.stringify(featureIds)}, true)`);
              const rows = await tx
                .select({ id: entities.id })
                .from(entities)
                .where(eq(entities.workspaceId, workspaceId))
                .orderBy(asc(entities.id));
              expect(rows.map((row) => row.id).toSorted()).toEqual(
                (enabled ? [taskId, factId] : [taskId]).toSorted(),
              );
              expect(
                await tx
                  .select({ value: count() })
                  .from(entities)
                  .where(eq(entities.workspaceId, workspaceId)),
              ).toEqual([{ value: enabled ? 2 : 1 }]);
              expect(
                await tx
                  .select({ id: entityVersions.id })
                  .from(entityVersions)
                  .where(eq(entityVersions.id, versionId)),
              ).toEqual(enabled ? [{ id: versionId }] : []);
              expect(
                await tx
                  .select({ id: searchDocuments.entityId })
                  .from(searchDocuments)
                  .where(eq(searchDocuments.workspaceId, workspaceId)),
              ).toEqual(enabled ? [{ id: factId }] : []);
              expect(
                await tx
                  .select({ id: documentTranslationUnits.id })
                  .from(documentTranslationUnits)
                  .where(eq(documentTranslationUnits.workspaceId, workspaceId)),
              ).toEqual(enabled ? [{ id: translationUnitId }] : []);
              expect(
                await tx
                  .select({ id: legalListClaims.id })
                  .from(legalListClaims)
                  .where(eq(legalListClaims.workspaceId, workspaceId)),
              ).toEqual(enabled ? [{ id: claimId }] : []);
              const ledger = await tx
                .select({
                  id: timeEntries.id,
                  minutes: timeEntries.billedMinutes,
                  rate: timeEntries.rateAtEntry,
                  workItemId: entityContextId(timeEntries.workItemId),
                  reference: entityContextReference(timeEntries.workItemId),
                })
                .from(timeEntries)
                .where(eq(timeEntries.id, entryId));
              expect(ledger).toEqual([
                {
                  id: entryId,
                  minutes: 60,
                  rate: cents(12_000),
                  workItemId: enabled ? factId : null,
                  reference: enabled
                    ? { type: "available", id: factId }
                    : { type: "unavailable" },
                },
              ]);
              const ordinary = await tx
                .select({
                  parentId: entityContextId(entities.parentId),
                  reference: entityContextReference(entities.parentId),
                })
                .from(entities)
                .where(eq(entities.id, taskId));
              expect(ordinary).toEqual([
                {
                  parentId: enabled ? factId : null,
                  reference: enabled
                    ? { type: "available", id: factId }
                    : { type: "unavailable" },
                },
              ]);
              const obligation = await tx.query.workObligations.findFirst({
                where: { entityId: { eq: taskId } },
                columns: { sourceEntityId: false },
                extras: WORK_OBLIGATION_CONTEXT_EXTRAS,
              });
              expect(obligation).toMatchObject({
                workingTargetDate: "2026-10-06",
                sourceEntityId: enabled ? factId : null,
                sourceReference: enabled
                  ? { type: "available", id: factId }
                  : { type: "unavailable" },
              });
              const event = await tx.query.workObligationEvents.findFirst({
                where: { id: { eq: eventId } },
                columns: { details: false },
                extras: WORK_OBLIGATION_EVENT_CONTEXT_EXTRAS,
              });
              expect(event?.details).toMatchObject({
                type: "provenance_changed",
                previousSourceEntityId: enabled ? factId : null,
                nextSourceEntityId: null,
                previousSourceReference: enabled
                  ? { type: "available", id: factId }
                  : { type: "unavailable" },
                nextSourceReference: null,
              });
              expect(
                await tx
                  .update(workObligations)
                  .set({ workingTargetDate: "2026-10-07" })
                  .where(eq(workObligations.entityId, taskId))
                  .returning({ id: workObligations.entityId }),
              ).toEqual([{ id: taskId }]);
              if (!enabled) {
                expect(
                  await tx
                    .update(entities)
                    .set({ name: "Updated fact" })
                    .where(eq(entities.id, factId))
                    .returning({ id: entities.id }),
                ).toEqual([]);
                expect(
                  await tx
                    .update(entities)
                    .set({ parentId: taskId })
                    .where(eq(entities.id, factId))
                    .returning({ id: entities.id }),
                ).toEqual([]);
                expect(
                  await tx
                    .delete(entities)
                    .where(eq(entities.id, factId))
                    .returning({ id: entities.id }),
                ).toEqual([]);
              }
              expect(
                await tx
                  .update(timeEntries)
                  .set({ durationMinutes: 90 })
                  .where(eq(timeEntries.id, entryId))
                  .returning({ id: timeEntries.id }),
              ).toEqual([{ id: entryId }]);
            });
            if (!enabled) {
              const insertion = client.begin(async (tx) => {
                await tx`SELECT set_config('role', 'stella', true),
                set_config(${SETTING_ORGANIZATION_ID}, ${organizationId}, true),
                set_config(${SETTING_USER_ID}, ${userId}, true),
                set_config(${SETTING_WORKSPACE_IDS}, ${`{${workspaceId}}`}, true),
                set_config(${SETTING_WORKSPACE_ACCESS_MODE}, ${WORKSPACE_ACCESS_MODE.explicit}, true),
                set_config('app.enabled_features', '[]', true)`;
                await tx`INSERT INTO entities (id, workspace_id, kind, list_item_type, name)
                VALUES (${Bun.randomUUIDv7()}, ${workspaceId}, 'task', 'fact', 'Additional fact')`;
              });
              expect(await rejectionOf(insertion)).toMatchObject({
                message:
                  'new row violates row-level security policy for table "entities"',
              });
            }
          } finally {
            await client`DELETE FROM time_entries WHERE id = ${entryId}`;
            await client`DELETE FROM organization WHERE id = ${organizationId}`;
            await client`DELETE FROM "user" WHERE id = ${userId}`;
          }
        });
      });
    }
  },
);
