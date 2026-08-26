import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql, TransactionRollbackError } from "drizzle-orm";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

import {
  stella,
  stellaCaseLawReader,
  stellaPublicLawReader,
} from "@/api/db/rls";
import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
} from "@/api/db/schema";
import {
  readDecisionHandler,
  readDecisionTextColumnWritten,
} from "@/api/handlers/case-law/decisions/get";
import { listDecisionsHandler } from "@/api/handlers/case-law/decisions/list";
import { withRedistributableSubject } from "@/api/handlers/case-law/decisions/public-subject";
import { rehydrateCaseLawCandidates } from "@/api/handlers/case-law/decisions/search";
import {
  listSitemapShardDecisionsHandler,
  listSitemapShardsHandler,
  readSitemapBucketShards,
  readSitemapDecisionAlternates,
} from "@/api/handlers/case-law/decisions/sitemap";
import { rehydrateLegislationCandidates } from "@/api/handlers/legislation/search";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { readDecisionAnalysis } from "@/api/lib/case-law/decision-analysis";
import {
  readDecisionLanguageAlternateCounts,
  readDecisionLanguageAlternateCountsQuery,
} from "@/api/lib/case-law/language-alternate-counts";
import { readNonRedistributableCaseLawSourceIdsQuery } from "@/api/lib/case-law/non-redistributable-sources";
import { getCollator } from "@/api/lib/collation";
import { readServingCorpusIndexGenerationTx } from "@/api/lib/legal-search/corpus-index-generation-store";
import { rehydrateCorpusIndexProviderCandidates } from "@/api/lib/legal-search/corpus-index-provider";
import { readDocumentContextDecision } from "@/api/lib/legal-search/document-context";
import { readPgFtsBrowseFacets } from "@/api/lib/legal-search/pg-fts-browse-facets";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import {
  publicLawDatabaseRolePermissionsSql,
  type PublicLawDatabaseRolePermissions,
} from "@/api/lib/public-law-read-db";
import {
  PUBLIC_LAW_COLUMNS_BY_RELATION,
  ROLLOUT_CASE_LAW_RELATIONS,
  ROLLOUT_CASE_LAW_SOURCE_COLUMNS,
  ROLLOUT_CASE_LAW_SOURCE_RELATION,
  ROLLOUT_CASE_LAW_WHOLE_RELATIONS,
} from "@/api/lib/public-law-relations";
import { PUBLIC_LAW_SHARED_QUERY } from "@/api/lib/public-law-shared-query";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

const DRIZZLE_DIR = nodePath.resolve(import.meta.dir, "../../../drizzle");
const READER_ROLE = stellaPublicLawReader.name;
const ROLLOUT_READER_ROLE = stellaCaseLawReader.name;
const WRITE_PRIVILEGES = "INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER";

const quoted = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

const errorMessageChain = (error: unknown): string => {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(" | ");
};

const forbiddenColumnRead = async (
  relation: string,
  column: string,
): Promise<unknown> =>
  await testDb
    .transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE ${quoted(READER_ROLE)}`));
      await tx.execute(
        sql.raw(`SELECT ${quoted(column)} FROM ${quoted(relation)}`),
      );
    })
    .then(
      () => null,
      (error: unknown) => error,
    );

const expectedQualifiedColumns = Object.entries(PUBLIC_LAW_COLUMNS_BY_RELATION)
  .flatMap(([relation, columns]) =>
    columns.map((column) => `${relation}.${column}`),
  )
  .toSorted();

let testDb: TestDatabase;

const revokeOtherDatabaseConnectFromPublic = async (
  tx: TestDatabaseTransaction,
): Promise<void> => {
  const result = await tx.execute<{ name: string }>(sql`
    SELECT datname AS name
    FROM pg_database
    WHERE NOT datistemplate
      AND datallowconn
      AND datname <> current_database()
  `);
  for (const { name } of result.rows) {
    // oxlint-disable-next-line no-await-in-loop -- database privileges are separate statements and the test transaction rolls them back together
    await tx.execute(
      sql.raw(`REVOKE CONNECT ON DATABASE ${quoted(name)} FROM PUBLIC`),
    );
  }
};

const rolePermissionsAfter = async (
  setup: (tx: TestDatabaseTransaction) => Promise<void>,
): Promise<PublicLawDatabaseRolePermissions | undefined> => {
  let permissions: PublicLawDatabaseRolePermissions | undefined;
  try {
    await testDb.transaction(async (tx) => {
      await revokeOtherDatabaseConnectFromPublic(tx);
      await setup(tx);
      await tx.execute(sql.raw(`SET LOCAL ROLE ${quoted(READER_ROLE)}`));
      const result = await tx.execute<PublicLawDatabaseRolePermissions>(
        publicLawDatabaseRolePermissionsSql(),
      );
      permissions = result.rows.at(0);
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
  return permissions;
};

const caseLawReaderDb = (): CaseLawPublicReadDb => {
  const readDb = async <T>(
    fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
  ): Promise<T> =>
    await testDb.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE ${quoted(READER_ROLE)}`));
      // SAFETY: the role transaction supplies the exact select/execute/query
      // surface exposed by the production public-law read boundary.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- role-scoped production query census
      return await fn(tx as unknown as CaseLawPublicReadTransaction);
    });

  // SAFETY: the symbol is a nominal marker; query behavior is established by
  // the role-scoped implementation above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only branded read handle
  return readDb as unknown as CaseLawPublicReadDb;
};

beforeAll(
  async () => {
    testDb = await getTestDb();
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  await releaseTestDb();
});

describe("public-law reader role", () => {
  test("can read exactly the allowlisted columns", async () => {
    const result = await testDb.execute<{ qualified: string }>(sql`
      SELECT tables.relname || '.' || columns.attname AS qualified
      FROM pg_attribute AS columns
      INNER JOIN pg_class AS tables ON tables.oid = columns.attrelid
      INNER JOIN pg_namespace AS schemas ON schemas.oid = tables.relnamespace
      WHERE schemas.nspname = 'public'
        AND tables.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND columns.attnum > 0
        AND NOT columns.attisdropped
        AND has_column_privilege(
          ${READER_ROLE},
          columns.attrelid,
          columns.attnum,
          'SELECT'
        )
      ORDER BY qualified
    `);

    expect(result.rows.map(({ qualified }) => qualified)).toEqual(
      expectedQualifiedColumns,
    );
  });

  test("has no table-level SELECT and cannot write or create", async () => {
    const result = await testDb.execute<{
      canCreate: boolean;
      readableTables: string[];
      writableTables: string[];
    }>(sql`
      SELECT
        has_schema_privilege(${READER_ROLE}, 'public', 'CREATE') AS "canCreate",
        ARRAY(
          SELECT tables.relname
          FROM pg_class AS tables
          INNER JOIN pg_namespace AS schemas
            ON schemas.oid = tables.relnamespace
          WHERE schemas.nspname = 'public'
            AND tables.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND has_table_privilege(${READER_ROLE}, tables.oid, 'SELECT')
          ORDER BY tables.relname
        ) AS "readableTables",
        ARRAY(
          SELECT tables.relname
          FROM pg_class AS tables
          INNER JOIN pg_namespace AS schemas
            ON schemas.oid = tables.relnamespace
          WHERE schemas.nspname = 'public'
            AND tables.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND has_table_privilege(
              ${READER_ROLE},
              tables.oid,
              ${WRITE_PRIVILEGES}
            )
          ORDER BY tables.relname
        ) AS "writableTables"
    `);

    expect(result.rows.at(0)).toEqual({
      canCreate: false,
      readableTables: [],
      writableTables: [],
    });
  });

  test("passes startup attestation, while the application role does not", async () => {
    const asRole = async (role: string) =>
      await testDb.transaction(async (tx) => {
        await revokeOtherDatabaseConnectFromPublic(tx);
        await tx.execute(sql.raw(`SET LOCAL ROLE ${quoted(role)}`));
        const result = await tx.execute<PublicLawDatabaseRolePermissions>(
          publicLawDatabaseRolePermissionsSql(),
        );
        return result.rows.at(0);
      });

    expect(await asRole(READER_ROLE)).toEqual({
      canAccessOtherDatabase: false,
      canUseOtherRole: false,
      canConnect: true,
      canDelegatePublicLaw: false,
      canReadPublicLaw: true,
      canReadOtherData: false,
      canUseSequence: false,
      canUseSchema: true,
      canWritePublicLaw: false,
      hasPrivilegedRoleAttributes: false,
      hasPublicLawReaderUsage: true,
    });
    expect(await asRole(stella.name)).toMatchObject({
      canReadOtherData: true,
    });
  });

  test("startup attestation rejects column writes and reads in other schemas", async () => {
    const columnWriter = await rolePermissionsAfter(async (tx) => {
      await tx.execute(
        sql.raw(
          `GRANT UPDATE (metadata) ON TABLE case_law_decisions TO ${quoted(READER_ROLE)}`,
        ),
      );
    });
    expect(columnWriter).toMatchObject({ canWritePublicLaw: true });

    const crossSchemaReader = await rolePermissionsAfter(async (tx) => {
      await tx.execute(sql`CREATE SCHEMA reader_attestation_probe`);
      await tx.execute(
        sql`CREATE TABLE reader_attestation_probe.private_data (id integer)`,
      );
      await tx.execute(
        sql.raw(
          `GRANT USAGE ON SCHEMA reader_attestation_probe TO ${quoted(READER_ROLE)}`,
        ),
      );
      await tx.execute(
        sql.raw(
          `GRANT SELECT (id) ON TABLE reader_attestation_probe.private_data TO ${quoted(READER_ROLE)}`,
        ),
      );
    });
    expect(crossSchemaReader).toMatchObject({ canReadOtherData: true });
  });

  test("startup attestation rejects database CREATE, sequences, and delegable SELECT", async () => {
    const databaseCreator = await rolePermissionsAfter(async (tx) => {
      const result = await tx.execute<{ name: string }>(
        sql`SELECT current_database() AS name`,
      );
      const databaseName = result.rows.at(0)?.name;
      if (databaseName === undefined) {
        throw new Error("current database name missing");
      }
      await tx.execute(
        sql.raw(
          `GRANT CREATE ON DATABASE ${quoted(databaseName)} TO ${quoted(READER_ROLE)}`,
        ),
      );
    });
    expect(databaseCreator).toMatchObject({ canWritePublicLaw: true });

    const sequenceUser = await rolePermissionsAfter(async (tx) => {
      await tx.execute(sql`CREATE SEQUENCE reader_attestation_probe_sequence`);
      await tx.execute(
        sql.raw(
          `GRANT USAGE ON SEQUENCE reader_attestation_probe_sequence TO ${quoted(READER_ROLE)}`,
        ),
      );
    });
    expect(sequenceUser).toMatchObject({ canUseSequence: true });

    const delegatingReader = await rolePermissionsAfter(async (tx) => {
      await tx.execute(
        sql.raw(
          `GRANT SELECT (id) ON TABLE case_law_decisions TO ${quoted(READER_ROLE)} WITH GRANT OPTION`,
        ),
      );
    });
    expect(delegatingReader).toMatchObject({ canDelegatePublicLaw: true });
  });

  test("startup attestation rejects every usable or settable role membership", async () => {
    const roleMember = await rolePermissionsAfter(async (tx) => {
      await tx.execute(sql`CREATE ROLE reader_attestation_escalation NOLOGIN`);
      await tx.execute(
        sql.raw(
          `GRANT reader_attestation_escalation TO ${quoted(READER_ROLE)} WITH SET FALSE, INHERIT TRUE`,
        ),
      );
    });

    expect(roleMember).toMatchObject({ canUseOtherRole: true });
  });

  test("startup attestation accepts a login that can assume only the reader role", async () => {
    let permissions: PublicLawDatabaseRolePermissions | undefined;
    try {
      await testDb.transaction(async (tx) => {
        await tx.execute(sql`CREATE ROLE reader_attestation_login NOLOGIN`);
        await tx.execute(
          sql.raw(`GRANT ${quoted(READER_ROLE)} TO reader_attestation_login`),
        );
        await tx.execute(sql`SET LOCAL ROLE reader_attestation_login`);
        const result = await tx.execute<PublicLawDatabaseRolePermissions>(
          publicLawDatabaseRolePermissionsSql(),
        );
        permissions = result.rows.at(0);
        tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof TransactionRollbackError)) {
        throw error;
      }
    }

    expect(permissions).toMatchObject({
      canUseOtherRole: false,
      canReadPublicLaw: true,
      canReadOtherData: false,
      hasPublicLawReaderUsage: true,
    });
  });

  test("startup attestation rejects privileged login attributes", async () => {
    let permissions: PublicLawDatabaseRolePermissions | undefined;
    try {
      await testDb.transaction(async (tx) => {
        await tx.execute(
          sql`CREATE ROLE reader_attestation_privileged NOLOGIN CREATEDB`,
        );
        await tx.execute(
          sql.raw(
            `GRANT ${quoted(READER_ROLE)} TO reader_attestation_privileged`,
          ),
        );
        await tx.execute(sql`SET LOCAL ROLE reader_attestation_privileged`);
        const result = await tx.execute<PublicLawDatabaseRolePermissions>(
          publicLawDatabaseRolePermissionsSql(),
        );
        permissions = result.rows.at(0);
        tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof TransactionRollbackError)) {
        throw error;
      }
    }

    expect(permissions).toMatchObject({
      hasPrivilegedRoleAttributes: true,
    });
  });

  test("startup attestation rejects a login that can delegate the reader role", async () => {
    let permissions: PublicLawDatabaseRolePermissions | undefined;
    try {
      await testDb.transaction(async (tx) => {
        await tx.execute(sql`CREATE ROLE reader_attestation_admin NOLOGIN`);
        await tx.execute(
          sql.raw(
            `GRANT ${quoted(READER_ROLE)} TO reader_attestation_admin WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`,
          ),
        );
        for (const [relation, columns] of Object.entries(
          PUBLIC_LAW_COLUMNS_BY_RELATION,
        )) {
          // oxlint-disable-next-line no-await-in-loop -- each statement gives the probe the exact direct projection while role inheritance stays disabled
          await tx.execute(
            sql.raw(
              `GRANT SELECT (${columns.map(quoted).join(", ")}) ON TABLE ${quoted(relation)} TO reader_attestation_admin`,
            ),
          );
        }
        await tx.execute(sql`SET LOCAL ROLE reader_attestation_admin`);
        const result = await tx.execute<PublicLawDatabaseRolePermissions>(
          publicLawDatabaseRolePermissionsSql(),
        );
        permissions = result.rows.at(0);
        tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof TransactionRollbackError)) {
        throw error;
      }
    }

    expect(permissions).toMatchObject({
      canUseOtherRole: false,
      canDelegatePublicLaw: true,
      canReadPublicLaw: true,
      canReadOtherData: false,
      hasPublicLawReaderUsage: false,
    });
  });

  test("SET ROLE can SELECT every surface and rejects an operational column", async () => {
    await testDb.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE ${quoted(READER_ROLE)}`));
      for (const [relation, columns] of Object.entries(
        PUBLIC_LAW_COLUMNS_BY_RELATION,
      )) {
        // oxlint-disable-next-line no-await-in-loop -- each statement proves the active role can resolve and read one exact relation projection
        await tx.execute(
          sql.raw(
            `SELECT ${columns.map(quoted).join(", ")} FROM ${quoted(relation)} LIMIT 0`,
          ),
        );
      }
    });
    const operationalColumnRejection = await forbiddenColumnRead(
      "legislation_sources",
      "config",
    );
    expect(operationalColumnRejection).toBeInstanceOf(Error);
    expect(errorMessageChain(operationalColumnRejection)).toContain(
      "permission denied",
    );
    expect(errorMessageChain(operationalColumnRejection)).toContain(
      "legislation_sources",
    );

    const publisherPayloadRejection = await forbiddenColumnRead(
      "legislation_documents",
      "metadata",
    );
    expect(publisherPayloadRejection).toBeInstanceOf(Error);
    expect(errorMessageChain(publisherPayloadRejection)).toContain(
      "permission denied",
    );
    expect(errorMessageChain(publisherPayloadRejection)).toContain(
      "legislation_documents",
    );
  });

  test("resolves both serving generations as the public-law reader role", async () => {
    try {
      await testDb.transaction(async (tx) => {
        await tx.insert(corpusIndexGenerations).values([
          {
            family: "case_law",
            generation: "case_law_v2",
            cluster: "q08",
            manifestDigest: "a".repeat(64),
            status: "serving",
          },
          {
            family: "legislation",
            generation: "legislation_v1",
            cluster: "q08",
            manifestDigest: "a".repeat(64),
            status: "serving",
          },
        ]);
        await tx.execute(sql.raw(`SET LOCAL ROLE ${quoted(READER_ROLE)}`));
        expect(
          await readServingCorpusIndexGenerationTx(tx, "case_law"),
        ).toMatchObject({ family: "case_law", generation: "case_law_v2" });
        expect(
          await readServingCorpusIndexGenerationTx(tx, "legislation"),
        ).toMatchObject({
          family: "legislation",
          generation: "legislation_v1",
        });
        tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof TransactionRollbackError)) {
        throw error;
      }
    }
  });

  test("executes the production legislation rehydration query as the reader role", async () => {
    const legislationDb: LegislationReadDb = async (fn) =>
      await testDb.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE ${quoted(READER_ROLE)}`));
        // SAFETY: the production Postgres transaction supplies the exact
        // select/execute surface exposed by LegislationReadTransaction.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- role-scoped production query census
        return await fn(tx as unknown as LegislationReadTransaction);
      });

    const result = await rehydrateLegislationCandidates({
      body: { query: "reader role census" },
      candidates: [{ id: createSafeId<"legislationDocument">(), score: 1 }],
      legislationDb,
    });

    expect(result.ranked).toEqual([]);
  });

  test("executes list, sitemap, and search projections as the reader role", async () => {
    const caseLawDb = caseLawReaderDb();

    const list = await listDecisionsHandler({}, caseLawDb);
    expect(list).toMatchObject({ items: [] });
    await readDecisionLanguageAlternateCounts({
      caseLawDb,
      languageGroupKeys: ["reader-role-census"],
    });

    const shards = await listSitemapShardsHandler(caseLawDb);
    expect(shards).toMatchObject({ items: [] });
    await caseLawDb(async (tx) => {
      await readSitemapBucketShards(tx);
      await readSitemapDecisionAlternates(tx, ["reader-role-census"]);
    });

    const shard = await listSitemapShardDecisionsHandler(
      { country: "cz", year: "2026", month: "08" },
      caseLawDb,
    );
    expect(shard).toMatchObject({ items: [] });

    const search = await rehydrateCaseLawCandidates({
      body: { query: "reader role census" },
      candidates: [{ id: createSafeId<"caseLawDecision">(), score: 1 }],
      caseLawDb,
      generation: "case_law_v3",
    });
    expect(search.ranked).toEqual([]);
  });

  test("executes every declared shared-reader query as the reader role", async () => {
    const caseLawDb = caseLawReaderDb();
    const decisionId = createSafeId<"caseLawDecision">();
    const sourceId = createSafeId<"caseLawSource">();
    const exercised = new Set<string>();

    await testDb.insert(caseLawSources).values({
      id: sourceId,
      adapterKey: "reader-role-census",
      name: "Reader role census",
    });
    await testDb.insert(caseLawDecisions).values({
      id: decisionId,
      sourceId,
      caseNumber: "reader-role-census",
      court: "Reader role census",
      country: "CZE",
      language: "cs",
      languageGroupKey: "reader-role-census",
    });

    try {
      const decision = await withRedistributableSubject(
        caseLawDb,
        { kind: "id", id: decisionId },
        async (subject) => await readDecisionHandler({ subject }),
      );
      expect(decision).not.toBeNull();
      exercised.add(readDecisionHandler.publicLawSharedQuery);

      await caseLawDb(async (tx) => {
        await readDecisionTextColumnWritten(tx, decisionId);
        exercised.add(readDecisionTextColumnWritten.publicLawSharedQuery);

        await readDecisionAnalysis(tx, decisionId);
        exercised.add(readDecisionAnalysis.publicLawSharedQuery);

        await readPgFtsBrowseFacets(tx, { excludedSourceIds: [], limit: 10 });
        exercised.add(readPgFtsBrowseFacets.publicLawSharedQuery);

        await readDecisionLanguageAlternateCountsQuery(tx, [
          "reader-role-census",
        ]);
        exercised.add(
          readDecisionLanguageAlternateCountsQuery.publicLawSharedQuery,
        );

        await readDocumentContextDecision(tx, decisionId);
        exercised.add(readDocumentContextDecision.publicLawSharedQuery);

        await readNonRedistributableCaseLawSourceIdsQuery(tx);
        exercised.add(
          readNonRedistributableCaseLawSourceIdsQuery.publicLawSharedQuery,
        );

        await rehydrateCorpusIndexProviderCandidates(tx, {
          generation: "case_law_v3",
          ids: [decisionId],
        });
        exercised.add(
          rehydrateCorpusIndexProviderCandidates.publicLawSharedQuery,
        );
      });

      expect([...exercised].toSorted()).toEqual(
        Object.values(PUBLIC_LAW_SHARED_QUERY).toSorted(),
      );
    } finally {
      await testDb
        .delete(caseLawDecisions)
        .where(eq(caseLawDecisions.id, decisionId));
      await testDb
        .delete(caseLawSources)
        .where(eq(caseLawSources.id, sourceId));
    }
  });

  test("preserves the v0.7.22 reader during the rollout window", async () => {
    await testDb.transaction(async (tx) => {
      await tx.execute(
        sql.raw(`SET LOCAL ROLE ${quoted(ROLLOUT_READER_ROLE)}`),
      );
      for (const relation of ROLLOUT_CASE_LAW_WHOLE_RELATIONS) {
        // oxlint-disable-next-line no-await-in-loop -- each statement proves the previous reader contract still resolves after the additive migration
        await tx.execute(sql.raw(`SELECT * FROM ${quoted(relation)} LIMIT 0`));
      }
      await tx.execute(
        sql.raw(
          `SELECT ${ROLLOUT_CASE_LAW_SOURCE_COLUMNS.map(quoted).join(", ")} FROM ${quoted(ROLLOUT_CASE_LAW_SOURCE_RELATION)} LIMIT 0`,
        ),
      );
    });
    const legislationRejection: unknown = await testDb
      .transaction(async (tx) => {
        await tx.execute(
          sql.raw(`SET LOCAL ROLE ${quoted(ROLLOUT_READER_ROLE)}`),
        );
        await tx.execute(sql.raw('SELECT "id" FROM "legislation_documents"'));
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(legislationRejection).toBeInstanceOf(Error);
    expect(errorMessageChain(legislationRejection)).toContain(
      "permission denied",
    );
    expect(errorMessageChain(legislationRejection)).toContain(
      "legislation_documents",
    );
  });

  test("has a SELECT policy on every allowlisted relation and no other", async () => {
    const result = await testDb.execute<{ tablename: string }>(sql`
      SELECT tablename
      FROM pg_policies
      WHERE schemaname = 'public'
        AND ${READER_ROLE} = ANY (roles)
        AND cmd = 'SELECT'
      ORDER BY tablename
    `);

    expect(result.rows.map(({ tablename }) => tablename)).toEqual(
      Object.keys(PUBLIC_LAW_COLUMNS_BY_RELATION).toSorted(),
    );
  });

  test("keeps the previous reader policies during rollout", async () => {
    const result = await testDb.execute<{ tablename: string }>(sql`
      SELECT tablename
      FROM pg_policies
      WHERE schemaname = 'public'
        AND ${ROLLOUT_READER_ROLE} = ANY (roles)
        AND cmd = 'SELECT'
      ORDER BY tablename
    `);

    expect(result.rows.map(({ tablename }) => tablename)).toEqual(
      [...ROLLOUT_CASE_LAW_RELATIONS].toSorted(),
    );
  });
});

type EffectiveSelectGrants = {
  tables: Set<string>;
  columns: Map<string, Set<string>>;
};

const stripLineComments = (contents: string): string =>
  contents
    .split(/\r?\n/u)
    .map((line) => {
      const commentStart = line.indexOf("--");
      return commentStart === -1 ? line : line.slice(0, commentStart);
    })
    .join("\n");

const identifiers = (list: string): string[] =>
  list.split(",").map((entry) => entry.trim().replaceAll('"', ""));

const STATEMENT_PATTERN =
  /^(?<verb>GRANT|REVOKE) SELECT(?: \((?<columns>[^)]+)\))? ON TABLE (?<tables>.+?) (?:TO|FROM) "?(?<role>stella_(?:caselaw_reader|public_law_reader))"?$/iu;
const READER_SELECT_STATEMENT_PATTERN = /^(?:GRANT|REVOKE) SELECT\b/iu;
const READER_ROLE_NAME_PATTERN =
  /\bstella_(?:caselaw_reader|public_law_reader)\b/iu;

const foldReaderSelectGrants = (
  sqlSources: readonly string[],
  readerRole: string,
): EffectiveSelectGrants => {
  const effective: EffectiveSelectGrants = {
    tables: new Set(),
    columns: new Map(),
  };
  for (const source of sqlSources) {
    for (const raw of stripLineComments(source).split(";")) {
      const statement = raw.replaceAll(/\s+/gu, " ").trim();
      const match = STATEMENT_PATTERN.exec(statement);
      if (match?.groups === undefined) {
        if (
          READER_SELECT_STATEMENT_PATTERN.test(statement) &&
          READER_ROLE_NAME_PATTERN.test(statement)
        ) {
          throw new Error(`Unsupported reader SELECT statement: ${statement}`);
        }
        continue;
      }
      if (match.groups["role"] !== readerRole) {
        continue;
      }
      const granting = match.groups["verb"]?.toUpperCase() === "GRANT";
      const tables = identifiers(match.groups["tables"] ?? "");
      const columnList = match.groups["columns"];
      for (const table of tables) {
        if (columnList === undefined) {
          if (granting) {
            effective.tables.add(table);
          } else {
            effective.tables.delete(table);
          }
          continue;
        }
        const columns = effective.columns.get(table) ?? new Set<string>();
        for (const column of identifiers(columnList)) {
          if (granting) {
            columns.add(column);
          } else {
            columns.delete(column);
          }
        }
        if (columns.size === 0) {
          effective.columns.delete(table);
        } else {
          effective.columns.set(table, columns);
        }
      }
    }
  }
  return effective;
};

const sortedColumns = (grants: EffectiveSelectGrants) =>
  Object.fromEntries(
    [...grants.columns.entries()]
      .toSorted(([a], [b]) => getCollator("en").compare(a, b))
      .map(([table, columns]) => [table, [...columns].toSorted()]),
  );

describe("public-law reader migrations", () => {
  test("effective grants equal the source-of-truth map", () => {
    const sources = readdirSync(DRIZZLE_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        nodePath.resolve(DRIZZLE_DIR, entry.name, "migration.sql"),
      )
      .filter((path) => existsSync(path))
      .toSorted()
      .map((path) => readFileSync(path, "utf-8"));

    const grants = foldReaderSelectGrants(sources, READER_ROLE);
    const expected = Object.fromEntries(
      Object.entries(PUBLIC_LAW_COLUMNS_BY_RELATION).map(
        ([relation, columns]) => [relation, [...columns].toSorted()],
      ),
    );

    expect([...grants.tables]).toEqual([]);
    expect(sortedColumns(grants)).toEqual(expected);
  });

  test("keeps the previous reader grants unchanged during rollout", () => {
    const sources = readdirSync(DRIZZLE_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        nodePath.resolve(DRIZZLE_DIR, entry.name, "migration.sql"),
      )
      .filter((path) => existsSync(path))
      .toSorted()
      .map((path) => readFileSync(path, "utf-8"));

    const grants = foldReaderSelectGrants(sources, ROLLOUT_READER_ROLE);

    expect([...grants.tables].toSorted()).toEqual([
      ...ROLLOUT_CASE_LAW_WHOLE_RELATIONS,
    ]);
    expect(sortedColumns(grants)).toEqual({
      [ROLLOUT_CASE_LAW_SOURCE_RELATION]: [
        ...ROLLOUT_CASE_LAW_SOURCE_COLUMNS,
      ].toSorted(),
    });
  });

  test("a later REVOKE undoes table and column grants", () => {
    const grants = foldReaderSelectGrants(
      [
        `GRANT SELECT ON TABLE "a", "b" TO stella_public_law_reader;
         GRANT SELECT (x, y) ON TABLE "c" TO stella_public_law_reader;`,
        `REVOKE SELECT ON TABLE "b" FROM stella_public_law_reader;
         REVOKE SELECT (y) ON TABLE "c" FROM stella_public_law_reader;`,
      ],
      READER_ROLE,
    );

    expect([...grants.tables].toSorted()).toEqual(["a"]);
    expect(sortedColumns(grants)).toEqual({ c: ["x"] });
  });

  test("rejects reader SELECT syntax outside the audited grammar", () => {
    expect(() =>
      foldReaderSelectGrants(
        [
          "GRANT SELECT ON ALL TABLES IN SCHEMA public TO stella_public_law_reader;",
        ],
        READER_ROLE,
      ),
    ).toThrow("Unsupported reader SELECT statement");
    expect(() =>
      foldReaderSelectGrants(
        ['GRANT SELECT ON TABLE "a" TO other_role, stella_public_law_reader;'],
        READER_ROLE,
      ),
    ).toThrow("Unsupported reader SELECT statement");
    expect(() =>
      foldReaderSelectGrants(
        ['GRANT SELECT ON TABLE "a" TO GROUP stella_public_law_reader;'],
        READER_ROLE,
      ),
    ).toThrow("Unsupported reader SELECT statement");
  });
});
