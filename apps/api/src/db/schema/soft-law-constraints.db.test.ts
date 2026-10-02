import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";

import { createSafeId } from "@/api/lib/branded-types";
import {
  SOFT_LAW_ATTEMPT_STATES,
  SOFT_LAW_ITEM_TAGS,
} from "@/api/lib/legal-search/soft-law-types";
import type {
  SoftLawDeferredObservation,
  SoftLawEntry,
} from "@/api/lib/legal-search/soft-law-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import * as softLawSchema from "./soft-law";

const configurations = Object.values(softLawSchema).map((table) =>
  getTableConfig(table),
);

const postgresFailure = (error: unknown) => {
  let current = error;
  for (let depth = 0; depth < 8; depth++) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    if (
      "code" in current &&
      typeof current.code === "string" &&
      "constraint" in current &&
      typeof current.constraint === "string"
    ) {
      return { code: current.code, constraint: current.constraint };
    }
    if (!("cause" in current)) {
      return undefined;
    }
    current = current.cause;
  }
  return undefined;
};

test("soft-law foreign keys have explicit names", () => {
  for (const configuration of configurations) {
    expect(configuration.foreignKeys.every((key) => key.isNameExplicit())).toBe(
      true,
    );
  }
});

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("soft-law migrated constraint parity", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS and DATABASE_URL", () => {
      expect(Boolean(databaseUrl) && enabled).toBe(false);
    });
  });
} else {
  test("migrated soft-law CHECK and foreign key names match the live schema", async () =>
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const expected = configurations.flatMap((configuration) => [
        ...configuration.checks.map((check) => ({
          relation: configuration.name,
          name: check.name,
          type: "c",
        })),
        ...configuration.foreignKeys.map((key) => ({
          relation: configuration.name,
          name: key.getName(),
          type: "f",
        })),
      ]);
      const actual = await db.execute<{
        relation: string;
        name: string;
        type: string;
      }>(sql`
        SELECT relation.relname AS relation,
          constraint_record.conname AS name,
          constraint_record.contype::text AS type
        FROM pg_catalog.pg_constraint constraint_record
        JOIN pg_catalog.pg_class relation
          ON relation.oid = constraint_record.conrelid
        JOIN pg_catalog.pg_namespace namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname IN (${sql.join(
            configurations.map(({ name }) => sql`${name}`),
            sql`, `,
          )})
          AND constraint_record.contype IN ('c', 'f')
      `);
      const constraintKeys = (
        constraints: readonly {
          relation: string;
          name: string;
          type: string;
        }[],
      ) =>
        constraints
          .map(({ relation, name, type }) => `${relation}/${type}/${name}`)
          .toSorted();
      expect(constraintKeys(actual)).toEqual(constraintKeys(expected));
    }));

  test("migrated foreign keys preserve targets, ordered columns and update/delete actions", async () =>
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const expected = configurations.flatMap((configuration) =>
        configuration.foreignKeys.map((key) => {
          const reference = key.reference();
          const target = getTableConfig(reference.foreignTable);
          return {
            relation: configuration.name,
            name: key.getName(),
            columns: reference.columns.map(({ name }) => name),
            targetSchema: target.schema ?? "public",
            target: target.name,
            foreignColumns: reference.foreignColumns.map(({ name }) => name),
            onUpdate: key.onUpdate ?? "no action",
            onDelete: key.onDelete ?? "no action",
          };
        }),
      );
      const actual = await db.execute<(typeof expected)[number]>(sql`
        SELECT relation.relname AS relation, c.conname AS name,
          ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(number, position)
            JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.number
            ORDER BY k.position) AS columns,
          target_namespace.nspname AS "targetSchema", target.relname AS target,
          ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(number, position)
            JOIN pg_catalog.pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.number
            ORDER BY k.position) AS "foreignColumns",
          CASE c.confupdtype WHEN 'a' THEN 'no action' WHEN 'r' THEN 'restrict'
            WHEN 'c' THEN 'cascade' WHEN 'n' THEN 'set null' WHEN 'd' THEN 'set default' END AS "onUpdate",
          CASE c.confdeltype WHEN 'a' THEN 'no action' WHEN 'r' THEN 'restrict'
            WHEN 'c' THEN 'cascade' WHEN 'n' THEN 'set null' WHEN 'd' THEN 'set default' END AS "onDelete"
        FROM pg_catalog.pg_constraint c
        JOIN pg_catalog.pg_class relation ON relation.oid = c.conrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN pg_catalog.pg_class target ON target.oid = c.confrelid
        JOIN pg_catalog.pg_namespace target_namespace ON target_namespace.oid = target.relnamespace
        WHERE namespace.nspname = 'public' AND c.contype = 'f'
          AND relation.relname IN (${sql.join(
            configurations.map(({ name }) => sql`${name}`),
            sql`, `,
          )})
      `);
      const keys = (rows: typeof expected) =>
        rows
          .map((row) =>
            JSON.stringify(
              Object.entries(row).toSorted(([left], [right]) =>
                left < right ? -1 : Number(left > right),
              ),
            ),
          )
          .toSorted();
      expect(keys(actual)).toEqual(keys(expected));
    }));

  test("migrated indexes preserve uniqueness, ordered keys and PostgreSQL-canonical predicates", async () =>
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      await db.transaction(async (tx) => {
        const expected: {
          relation: string;
          name: string;
          columns: string[];
          unique: boolean;
          predicate: string | null;
        }[] = [];
        for (const configuration of configurations) {
          const shadow = `parity_${configuration.name}`;
          await tx.execute(sql`CREATE TEMP TABLE ${sql.identifier(shadow)}
            (LIKE public.${sql.identifier(configuration.name)}) ON COMMIT DROP`);
          for (const unique of configuration.uniqueConstraints) {
            expected.push({
              relation: configuration.name,
              name: unique.getName() ?? panic("Unique constraint has no name"),
              columns: unique.columns.map(({ name }) => name),
              unique: true,
              predicate: null,
            });
          }
          for (const column of configuration.columns.filter(
            (candidate) => candidate.isUnique,
          )) {
            expected.push({
              relation: configuration.name,
              name:
                column.uniqueName ??
                panic("Unique column has no constraint name"),
              columns: [column.name],
              unique: true,
              predicate: null,
            });
          }
          for (const index of configuration.indexes) {
            const name = index.config.name ?? panic("Index has no name");
            const columns = index.config.columns.map((column) => {
              if (!("name" in column) || typeof column.name !== "string") {
                return panic("Soft-law index must declare a column key");
              }
              return column.name;
            });
            const rendered = index.config.where
              ? new PgDialect().sqlToQuery(index.config.where)
              : null;
            if (rendered && rendered.params.length !== 0) {
              panic("Index predicate unexpectedly uses bound parameters");
            }
            const predicate = rendered
              ? sql.raw(rendered.sql.replaceAll(`"${configuration.name}".`, ""))
              : null;
            await tx.execute(sql`CREATE ${index.config.unique ? sql`UNIQUE` : sql``} INDEX ${sql.identifier(name)}
              ON ${sql.identifier(shadow)} (${sql.join(
                columns.map((column) => sql.identifier(column)),
                sql`, `,
              )})
              ${predicate ? sql`WHERE ${predicate}` : sql``}`);
            const canonical =
              (
                await tx.execute<{ predicate: string | null }>(sql`
              SELECT pg_catalog.pg_get_expr(i.indpred, i.indrelid) AS predicate
              FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class r ON r.oid = i.indexrelid
              WHERE r.relnamespace = pg_catalog.pg_my_temp_schema() AND r.relname = ${name}
            `)
              ).at(0) ?? panic("Schema-derived index is missing");
            expected.push({
              relation: configuration.name,
              name,
              columns,
              unique: index.config.unique,
              predicate: canonical.predicate,
            });
          }
        }
        const actual = await tx.execute<{
          relation: string;
          name: string;
          columns: string[];
          unique: boolean;
          predicate: string | null;
        }>(sql`
          SELECT relation.relname AS relation, index_relation.relname AS name,
            ARRAY(SELECT pg_catalog.pg_get_indexdef(i.indexrelid, position, true)
              FROM generate_series(1, i.indnkeyatts) position ORDER BY position) AS columns,
            i.indisunique AS unique, pg_catalog.pg_get_expr(i.indpred, i.indrelid) AS predicate
          FROM pg_catalog.pg_index i
          JOIN pg_catalog.pg_class relation ON relation.oid = i.indrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
          JOIN pg_catalog.pg_class index_relation ON index_relation.oid = i.indexrelid
          WHERE namespace.nspname = 'public' AND NOT i.indisprimary
            AND relation.relname IN (${sql.join(
              configurations.map(({ name }) => sql`${name}`),
              sql`, `,
            )})
        `);
        const keys = (rows: typeof expected) =>
          rows
            .map((row) =>
              JSON.stringify(
                Object.entries(row).toSorted(([left], [right]) =>
                  left < right ? -1 : Number(left > right),
                ),
              ),
            )
            .toSorted();
        expect(keys(actual)).toEqual(keys(expected));
      });
    }));

  test("migrated version checks reject nonpositive sequence numbers and reversed observation intervals", async () =>
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const sourceId = Bun.randomUUIDv7();
      const documentId = Bun.randomUUIDv7();
      const observedFrom = new Date("2024-01-02T00:00:00Z");
      await db.execute(sql`INSERT INTO soft_law_sources (id, adapter_key, descriptor)
        VALUES (${sourceId}, ${`constraint-parity-${sourceId}`}, '{}'::jsonb)`);
      try {
        await db.execute(sql`INSERT INTO soft_law_documents (
          id, source_id, identity_key, jurisdiction, authority, kind, title,
          stated_reference_state, issued_on_state, listing_state, validity_state,
          validity_basis, first_seen_at, last_seen_at, last_seen_run)
          VALUES (${documentId}, ${sourceId}, 'constraint-parity', 'cz', 'cz-uoou',
            'recommendation', 'Constraint parity', 'not_stated', 'not_stated', 'listed',
            'not_stated', 'source_stated', ${observedFrom}, ${observedFrom}, ${Bun.randomUUIDv7()})`);
        const insert = async (sequence: number, observedTo: Date | null) =>
          await db.execute(sql`INSERT INTO soft_law_document_versions (
            id, document_id, sequence, content_hash, raw_objects, metadata,
            extraction_quality, source_dates, observed_from, observed_to)
            VALUES (${Bun.randomUUIDv7()}, ${documentId}, ${sequence}, 'constraint-parity',
              '[]'::jsonb, '{}'::jsonb, 'html', '{}'::jsonb, ${observedFrom}, ${observedTo})`);
        // Equality is a valid interval; the invalid witnesses differ only on the tested boundary.
        await insert(1, observedFrom);
        const invalid = [
          {
            sequence: 0,
            observedTo: observedFrom,
            constraint: "soft_law_versions_sequence_check",
          },
          {
            sequence: -1,
            observedTo: observedFrom,
            constraint: "soft_law_versions_sequence_check",
          },
          {
            sequence: 2,
            observedTo: new Date("2024-01-01T00:00:00Z"),
            constraint: "soft_law_versions_window_check",
          },
        ];
        for (const witness of invalid) {
          const attempted = await Result.tryPromise(
            async () => await insert(witness.sequence, witness.observedTo),
          );
          if (attempted.status !== "error") {
            panic(`Invalid version accepted by ${witness.constraint}`);
          }
          expect(postgresFailure(attempted.error.cause)).toEqual({
            code: "23514",
            constraint: witness.constraint,
          });
        }
        await insert(2, null);
      } finally {
        await db.execute(
          sql`DELETE FROM soft_law_document_versions WHERE document_id = ${documentId}`,
        );
        await db.execute(
          sql`DELETE FROM soft_law_documents WHERE id = ${documentId}`,
        );
        await db.execute(
          sql`DELETE FROM soft_law_sources WHERE id = ${sourceId}`,
        );
      }
    }));
  test("collision receipts require identity while every other receipt forbids it", async () =>
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const sourceId = Bun.randomUUIDv7();
      await db.execute(sql`INSERT INTO soft_law_sources (id, adapter_key, descriptor)
        VALUES (${sourceId}, ${`identity-parity-${sourceId}`}, '{}'::jsonb)`);
      type ReceiptWitness = {
        status: (typeof SOFT_LAW_ATTEMPT_STATES)[number];
        tag: (typeof SOFT_LAW_ITEM_TAGS)[number] | null;
        identityKey: string | null;
      };
      const insert = async ({ status, tag, identityKey }: ReceiptWitness) => {
        const url = `https://uoou.gov.cz/receipt/${Bun.randomUUIDv7()}`;
        const entry = {
          url,
          metadata: {
            title: "Receipt constraint",
            kind: "recommendation",
            statedReference: { state: "not_stated" },
            issuedOn: { state: "not_stated" },
            validity: { state: "not_stated", basis: "source_stated" },
          },
          sourceDates: {},
        } satisfies SoftLawEntry;
        await db.execute(sql`INSERT INTO soft_law_ingestion_attempts (
          id, source_id, run_id, url, entry, status, tag, identity_key, count, observed_at)
          VALUES (${Bun.randomUUIDv7()}, ${sourceId}, ${Bun.randomUUIDv7()}, ${url},
            ${JSON.stringify(entry)}::text::jsonb, ${status}, ${tag}, ${identityKey}, 1, now())`);
      };
      const otherTags = SOFT_LAW_ITEM_TAGS.filter(
        (tag) => tag !== "identity_collision",
      );
      const nonRejected = SOFT_LAW_ATTEMPT_STATES.filter(
        (status) => status !== "rejected" && status !== "deferred",
      );
      const accepted = [
        {
          status: "rejected",
          tag: "identity_collision",
          identityKey: "identity",
        },
        ...otherTags.map((tag) => ({
          status: "rejected" as const,
          tag,
          identityKey: null,
        })),
        ...nonRejected.map((status) => ({
          status,
          tag: null,
          identityKey: null,
        })),
      ] as const satisfies readonly ReceiptWitness[];
      const rejected = [
        { status: "rejected", tag: "identity_collision", identityKey: null },
        ...otherTags.map((tag) => ({
          status: "rejected" as const,
          tag,
          identityKey: "identity",
        })),
        ...nonRejected.map((status) => ({
          status,
          tag: null,
          identityKey: "identity",
        })),
      ] as const satisfies readonly ReceiptWitness[];
      try {
        for (const witness of accepted) {
          await insert(witness);
        }
        for (const witness of rejected) {
          const attempted = await Result.tryPromise(
            async () => await insert(witness),
          );
          if (attempted.status !== "error") {
            panic(
              "Receipt identity CHECK accepted an invalid tag/identity pair",
            );
          }
          expect(postgresFailure(attempted.error.cause)).toEqual({
            code: "23514",
            constraint: "soft_law_attempts_identity_check",
          });
        }
      } finally {
        await db.execute(
          sql`DELETE FROM soft_law_ingestion_attempts WHERE source_id = ${sourceId}`,
        );
        await db.execute(
          sql`DELETE FROM soft_law_sources WHERE id = ${sourceId}`,
        );
      }
    }));
  test("deferred receipts require an object snapshot and retain its complete decision input", async () =>
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const sourceId = createSafeId<"softLawSource">();
      const entry = {
        url: "https://uoou.gov.cz/deferred-guidance",
        metadata: {
          title: "Deferred guidance",
          kind: "recommendation",
          statedReference: { state: "not_stated" },
          issuedOn: { state: "not_stated" },
          validity: { state: "not_stated", basis: "source_stated" },
        },
        sourceDates: {},
      } satisfies SoftLawEntry;
      const observation = {
        entry,
        input: {
          metadata: entry.metadata,
          text: "Deferred guidance text",
          extractionQuality: "html",
          sourceDates: entry.sourceDates,
        },
        documentId: createSafeId<"softLawDocument">(),
        identityKey: "deferred-identity",
        contentHash: "deferred-content-hash",
        rawObjects: [
          {
            role: "document",
            key: "test/retained.html",
            contentType: "text/html",
          },
        ],
      } satisfies SoftLawDeferredObservation;
      await db.execute(sql`INSERT INTO soft_law_sources (id, adapter_key, descriptor)
        VALUES (${sourceId}, ${`deferred-parity-${sourceId}`}, '{}'::jsonb)`);
      const insert = async (snapshot: string | null) =>
        await db.execute(sql`INSERT INTO soft_law_ingestion_attempts (
          id, source_id, run_id, url, entry, status, count, observation, observed_at)
          VALUES (${Bun.randomUUIDv7()}, ${sourceId}, ${Bun.randomUUIDv7()}, ${entry.url},
            ${JSON.stringify(entry)}::text::jsonb, 'deferred', 1, ${snapshot}::text::jsonb, now())`);
      try {
        await insert(JSON.stringify(observation));
        expect(
          (
            await db.execute<{ observation: SoftLawDeferredObservation }>(sql`
            SELECT observation FROM soft_law_ingestion_attempts WHERE source_id = ${sourceId}
          `)
          ).map((row) => row.observation),
        ).toEqual([observation]);
        for (const malformed of [null, "null", "[]", '"scalar"', "42"]) {
          const attempted = await Result.tryPromise(
            async () => await insert(malformed),
          );
          if (attempted.status !== "error") {
            panic("Deferred receipt accepted a missing or nonobject snapshot");
          }
          expect(postgresFailure(attempted.error.cause)).toEqual({
            code: "23514",
            constraint: "soft_law_attempts_deferred_check",
          });
        }
      } finally {
        await db.execute(
          sql`DELETE FROM soft_law_ingestion_attempts WHERE source_id = ${sourceId}`,
        );
        await db.execute(
          sql`DELETE FROM soft_law_sources WHERE id = ${sourceId}`,
        );
      }
    }));
  test("deciding sources may hold or release a paired lease while retaining their walk identity", async () =>
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const sourceId = createSafeId<"softLawSource">();
      const runId = Bun.randomUUIDv7();
      const leaseToken = createSafeId<"softLawIngestionLease">();
      await db.execute(sql`INSERT INTO soft_law_sources (
        id, adapter_key, descriptor, run_state, run_id, run_started_at, lease_token, lease_expires_at)
        VALUES (${sourceId}, ${`deciding-parity-${sourceId}`}, '{}'::jsonb,
          'deciding', ${runId}, now(), ${leaseToken}, now() + interval '5 minutes')`);
      try {
        const malformedLease = await Result.tryPromise(
          async () =>
            await db.execute(
              sql`UPDATE soft_law_sources SET lease_expires_at = NULL WHERE id = ${sourceId}`,
            ),
        );
        if (malformedLease.status !== "error") {
          panic("Deciding source accepted an unpaired lease");
        }
        expect(postgresFailure(malformedLease.error.cause)).toEqual({
          code: "23514",
          constraint: "soft_law_sources_lease_check",
        });
        await db.execute(sql`UPDATE soft_law_sources
          SET lease_token = NULL, lease_expires_at = NULL WHERE id = ${sourceId}`);
        expect(
          await db.execute<{ state: string; run: string }>(sql`
            SELECT run_state AS state, run_id::text AS run FROM soft_law_sources WHERE id = ${sourceId}
          `),
        ).toEqual([{ state: "deciding", run: runId }]);
        const missingRun = await Result.tryPromise(
          async () =>
            await db.execute(
              sql`UPDATE soft_law_sources SET run_id = NULL WHERE id = ${sourceId}`,
            ),
        );
        if (missingRun.status !== "error") {
          panic("Deciding source lost its walk identity");
        }
        expect(postgresFailure(missingRun.error.cause)).toEqual({
          code: "23514",
          constraint: "soft_law_sources_run_check",
        });
      } finally {
        await db.execute(
          sql`DELETE FROM soft_law_sources WHERE id = ${sourceId}`,
        );
      }
    }));
}
