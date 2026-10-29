import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { caseLawProvisionExtractions } from "@/api/db/schema";
import { listDecisionProvisionsHandler } from "@/api/handlers/case-law/provisions/list-for-decision";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import { publicLawDatabaseRolePermissionsSql } from "@/api/lib/public-law-read-db";
import {
  PROVISION_LINK_STATUS_COLUMN_GRANTS_BY_RELATION,
  publicLawColumnPairs,
} from "@/api/lib/public-law-relations";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("provision read status (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  test("public reader resolves the gated status and rejects a cursor after publication advances", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { sql: owner, db: ownerDb } = openClient();
      const { db: readerDb } = openClient();
      const sourceId = createSafeId<"caseLawSource">();
      const decisionId = createSafeId<"caseLawDecision">();
      const listingOnlyId = createSafeId<"caseLawDecision">();
      const redactedId = createSafeId<"caseLawDecision">();
      const language = "cs";
      const [initialScope] = await owner`
        SELECT status FROM case_law_provision_extraction_scopes
        WHERE country = 'CZE' AND language = ${language}`;
      const setStatusGrants = async (mode: "grant" | "revoke") => {
        const columnsByRelation = new Map<string, string[]>();
        for (const { relation, column } of publicLawColumnPairs(
          PROVISION_LINK_STATUS_COLUMN_GRANTS_BY_RELATION,
        )) {
          const columns = columnsByRelation.get(relation) ?? [];
          columns.push(column);
          columnsByRelation.set(relation, columns);
        }
        for (const [relation, columns] of columnsByRelation) {
          const selection = sql.join(
            columns.map((column) => sql.identifier(column)),
            sql`, `,
          );
          if (mode === "grant") {
            await ownerDb.execute(sql`GRANT SELECT (${selection}) ON TABLE ${sql.identifier(relation)}
              TO stella_public_law_reader`);
          } else {
            await ownerDb.execute(sql`REVOKE SELECT (${selection}) ON TABLE ${sql.identifier(relation)}
              FROM stella_public_law_reader`);
          }
        }
        if (mode === "grant") {
          await ownerDb.execute(
            sql.raw(`GRANT EXECUTE ON FUNCTION
            case_law_provision_extraction_in_scope(varchar, varchar),
            case_law_provision_extraction_input_digest(text, date, text, text, boolean)
            TO stella_public_law_reader`),
          );
        } else {
          await ownerDb.execute(
            sql.raw(`REVOKE EXECUTE ON FUNCTION
            case_law_provision_extraction_in_scope(varchar, varchar),
            case_law_provision_extraction_input_digest(text, date, text, text, boolean)
            FROM stella_public_law_reader`),
          );
        }
      };
      const [initialAccess] = await owner`
        SELECT has_function_privilege(
          'stella_public_law_reader',
          'public.case_law_provision_extraction_in_scope(character varying,character varying)',
          'EXECUTE'
        ) AS enabled`;
      const initialGrantMode =
        initialAccess?.enabled === true ? "grant" : "revoke";
      const readDb = asTestRaw<CaseLawPublicReadDb>(
        async <T>(read: (tx: CaseLawPublicReadTransaction) => Promise<T>) =>
          await readerDb.transaction(
            async (tx) => {
              await tx.execute(
                sql.raw("SET LOCAL ROLE stella_public_law_reader"),
              );
              return await read(asTestRaw<CaseLawPublicReadTransaction>(tx));
            },
            { isolationLevel: "repeatable read" },
          ),
      );
      const page = async (cursor?: string) =>
        (await withRedistributableSubject(
          readDb,
          "pages",
          { kind: "id", id: decisionId },
          async (subject) =>
            await listDecisionProvisionsHandler({
              subject,
              query: { limit: 1, ...(cursor === undefined ? {} : { cursor }) },
            }),
        )) ?? panic("expected a public decision subject");

      try {
        await owner`INSERT INTO case_law_sources (id, adapter_key, name)
          VALUES (${sourceId}::uuid, ${`provision-read-${Bun.randomUUIDv7()}`}, 'Test source')`;
        await owner`INSERT INTO case_law_provision_extraction_scopes
          (country, language, status, generation)
          VALUES ('CZE', ${language}, 'active', 1)
          ON CONFLICT (country, language) DO UPDATE
          SET status = 'active',
            generation = case_law_provision_extraction_scopes.generation + 1
          WHERE case_law_provision_extraction_scopes.status <> 'active'`;
        await owner`INSERT INTO case_law_decisions
          (id, source_id, country, language, court, case_number, content_hash)
          VALUES (${decisionId}::uuid, ${sourceId}::uuid, 'CZE', ${language},
            'Court', ${decisionId}, ${"a".repeat(64)})`;
        await owner`INSERT INTO case_law_decisions
          (id, source_id, country, language, court, case_number, content_hash, metadata, redacted_at, text_state)
          VALUES
            (${listingOnlyId}::uuid, ${sourceId}::uuid, 'CZE', ${language},
              'Court', ${listingOnlyId}, ${"b".repeat(64)},
              '{"_stellaPartialObservation":{"isListingOnly":true}}'::jsonb, NULL, DEFAULT),
            (${redactedId}::uuid, ${sourceId}::uuid, 'CZE', ${language},
              'Court', ${redactedId}, NULL, '{}'::jsonb, now(), NULL)`;
        for (const id of [listingOnlyId, redactedId]) {
          expect(
            await withRedistributableSubject(
              readDb,
              "pages",
              { kind: "id", id },
              async (subject) => subject.id,
            ),
          ).toBeNull();
        }
        for (const [start, anchor] of [
          [10, "a"],
          [20, "a"],
        ] as const) {
          await owner`INSERT INTO case_law_provision_citations
            (id, decision_id, jurisdiction, work_identifier, work_number, work_year,
             work_collection, unit, section, anchor, span_start, span_end,
             sentence_text, confidence)
            VALUES (${createSafeId<"caseLawProvisionCitation">()}::uuid,
              ${decisionId}::uuid, 'CZE', '89/2012 Sb.', 89, 2012, 'Sb.',
              'section', 1, ${anchor}, ${start}, ${start + 5}, 'citation', 1)`;
        }

        await setStatusGrants("revoke");
        const attestation = await readerDb.transaction(async (tx) => {
          await tx.execute(sql.raw("SET LOCAL ROLE stella_public_law_reader"));
          return await tx.execute(publicLawDatabaseRolePermissionsSql());
        });
        expect(attestation.at(0)).toMatchObject({
          canReadPublicLaw: true,
          canDelegatePublicLaw: false,
        });
        expect(await page()).toMatchObject({
          items: [
            {
              spanStart: 10,
              spanRole: null,
              selection: null,
              printedWorkIdentifier: null,
              targetDocumentId: null,
              targetStatus: null,
            },
          ],
          capability: { type: "supported", languages: ["cs"] },
          pendingSince: null,
          status: { type: "pending" },
          generation: "0",
          publishedProjectionDigest: null,
        });
        await setStatusGrants("grant");
        const activatedAttestation = await readerDb.transaction(async (tx) => {
          await tx.execute(sql.raw("SET LOCAL ROLE stella_public_law_reader"));
          return await tx.execute(publicLawDatabaseRolePermissionsSql());
        });
        expect(activatedAttestation.at(0)).toMatchObject({
          canReadPublicLaw: true,
          canDelegatePublicLaw: false,
        });

        const [queuedExtraction] = await ownerDb
          .select({ pendingSince: caseLawProvisionExtractions.pendingSince })
          .from(caseLawProvisionExtractions)
          .where(eq(caseLawProvisionExtractions.decisionId, decisionId));
        const pendingSince =
          queuedExtraction?.pendingSince ??
          panic("expected the decision insert to enqueue extraction");
        const first = await page();
        expect(first).toMatchObject({
          items: [{ spanStart: 10 }],
          capability: { type: "supported", languages: ["cs"] },
          pendingSince: pendingSince.toISOString(),
          status: { type: "legacy" },
          generation: "0",
          publishedProjectionDigest: null,
        });
        if (!("items" in first) || first.nextCursor === null) {
          panic("expected a cursor page");
        }
        await owner`INSERT INTO case_law_provision_extraction_revisions_registry
          (revision, jurisdiction, engine_input_digest, profile_digest, projection_revision)
          VALUES (1, 'CZE', ${"1".repeat(64)}, ${"2".repeat(64)}, 1)
          ON CONFLICT ON CONSTRAINT case_law_provision_extraction_revisions_registry_pkey
          DO NOTHING`;
        await owner`INSERT INTO case_law_provision_extraction_revisions
          (jurisdiction, desired_revision, min_current_revision)
          VALUES ('CZE', 1, 1)
          ON CONFLICT (jurisdiction) DO NOTHING`;
        const [revision] = await owner`
          SELECT min_current_revision AS floor
          FROM case_law_provision_extraction_revisions
          WHERE jurisdiction = 'CZE'`;
        const publishedRevision = Number(revision?.floor);
        expect(publishedRevision).toBeGreaterThan(0);
        await owner`UPDATE case_law_provision_extractions
          SET generation = 9007199254740993, outcome = 'extracted_with_rows',
            row_count = 2, rows_digest = ${"b".repeat(64)},
            published_projection_digest = decode(${"c".repeat(64)}, 'hex'),
            published_revision = ${publishedRevision}, published_jurisdiction = 'CZE',
            published_input_digest = desired_input_digest, published_at = now()
          WHERE decision_id = ${decisionId}::uuid`;

        expect(await page(first.nextCursor)).toMatchObject({
          code: 409,
          response: { type: "conflict" },
        });
        expect(await page()).toMatchObject({
          status: { type: "current" },
          generation: "9007199254740993",
          publishedProjectionDigest: "c".repeat(64),
        });
      } finally {
        await setStatusGrants(initialGrantMode);
        await owner`DELETE FROM case_law_decisions
          WHERE id IN (${decisionId}::uuid, ${listingOnlyId}::uuid, ${redactedId}::uuid)`;
        await owner`DELETE FROM case_law_sources WHERE id = ${sourceId}::uuid`;
        if (initialScope?.status === "retired") {
          await owner`UPDATE case_law_provision_extraction_scopes
            SET status = 'retired', generation = generation + 1
            WHERE country = 'CZE' AND language = ${language}`;
        }
      }
    });
  }, 20_000);
}
