import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { sql, TransactionRollbackError } from "drizzle-orm";
import type { SQLChunk, SQL } from "drizzle-orm";

import {
  oauthClient,
  oauthClientResource,
  oauthResource,
} from "@/api/db/auth-schema";
import {
  assertBetterAuthOAuthPolicyCensus,
  ensureBetterAuthOAuthPolicy,
} from "@/api/lib/db/better-auth-oauth-policy-census";
import { getBetterAuthOAuthResources } from "@/api/lib/oauth-resource-policy";
import { MCP_LAW_HTTP_PATH } from "@/api/mcp/constants";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

import { BETTER_AUTH_OAUTH_RESOURCE_REPAIR } from "./better-auth-oauth-resource-repair";
import { ONLINE_MIGRATION_REPAIRS } from "./online-migrations";

/**
 * Adding an MCP audience widens `buildBetterAuthOAuthResources()`, and the
 * startup census refuses to serve until `oauth_resource` matches it. Startup
 * deliberately never repairs, so without an automated path the next release's
 * API would fail its boot gate on every environment until an operator ran the
 * one-time 1.7 cutover script under a write freeze.
 *
 * What replaces that is this online repair, which the migrate entrypoint runs
 * on every deploy before the API rolls. These drive it through the
 * `OnlineRepair` entry the migrator calls, over a connection shaped like the
 * one the online phase reserves, against the real configured resource set
 * rather than a fixture, so what runs here is the deploy's own code path.
 */

let database: TestDatabase;

const CLIENT_ID = "online-repair-client";

setDefaultTimeout(120_000);

beforeAll(async () => {
  database = await getTestDb();
});

afterAll(async () => {
  await releaseTestDb();
});

/**
 * Rebuild a drizzle fragment from the parameterised query the repair emits. It
 * renders drizzle SQL to `(text, params)` for its raw connection; this reverses
 * that so the statement runs inside the test's transaction.
 */
const toDrizzleSql = (text: string, params: readonly unknown[]): SQL => {
  const chunks: SQLChunk[] = [];
  for (const [index, segment] of text.split(/\$(\d+)/gu).entries()) {
    if (index % 2 === 0) {
      chunks.push(sql.raw(segment));
      continue;
    }
    chunks.push(sql`${params[Number(segment) - 1]}`);
  }
  return sql.join(chunks);
};

const REPAIR_SAVEPOINT = "online_repair";

const translateTransactionControl = (query: string): string => {
  if (query === "BEGIN") {
    return `SAVEPOINT ${REPAIR_SAVEPOINT}`;
  }
  if (query === "COMMIT") {
    return `RELEASE SAVEPOINT ${REPAIR_SAVEPOINT}`;
  }
  if (query === "ROLLBACK") {
    return `ROLLBACK TO SAVEPOINT ${REPAIR_SAVEPOINT}`;
  }
  return query;
};

/**
 * The reserved-connection shape `online-migrations.ts` hands a repair.
 *
 * The repair owns its transaction and these tests own an outer one they roll
 * back, so its `BEGIN`/`COMMIT`/`ROLLBACK` are mapped onto a savepoint: the
 * repair keeps real atomicity and a failed run still leaves the session usable,
 * while the fixture stays rolled back. Nothing else is translated.
 */
const onlineConnection = (transaction: TestDatabaseTransaction) => {
  const run = async (query: string, params: readonly unknown[]) => {
    const result = await transaction.execute(
      toDrizzleSql(translateTransactionControl(query), params),
    );
    return result.rows;
  };
  return {
    execute: async (query: string, params: readonly unknown[] = []) => {
      await run(query, params);
    },
    query: async (query: string, params: readonly unknown[] = []) =>
      await run(query, params),
    release: () => undefined,
  };
};

const captureRejection = async (operation: Promise<void>): Promise<unknown> =>
  await operation.then(
    () => null,
    (error: unknown) => error,
  );

/** The resources a deployment served before the law audience was added. */
const preUpgradeResources = () =>
  getBetterAuthOAuthResources().filter(
    ({ identifier }) => !identifier.endsWith(MCP_LAW_HTTP_PATH),
  );

const lawResourceIdentifier = (): string => {
  const law = getBetterAuthOAuthResources().find(({ identifier }) =>
    identifier.endsWith(MCP_LAW_HTTP_PATH),
  );
  if (law === undefined) {
    throw new Error("the law audience is not a configured OAuth resource");
  }
  return law.identifier;
};

/** The pre-upgrade deployment: the resources it served, and a linked client. */
const givenPreUpgradeDeployment = async (
  transaction: TestDatabaseTransaction,
): Promise<void> => {
  await transaction.execute(sql`
    TRUNCATE "user", account, oauth_client_resource, oauth_resource,
             oauth_client CASCADE
  `);
  const resources = preUpgradeResources();
  await transaction.insert(oauthResource).values(
    resources.map((resource, index) => ({
      allowedScopes: [...resource.allowedScopes],
      id: `online-repair-resource-${index}`,
      identifier: resource.identifier,
      name: resource.name,
    })),
  );
  await transaction.insert(oauthClient).values({
    clientId: CLIENT_ID,
    id: "online-repair-client-row",
    redirectUris: ["https://client.example.invalid/callback"],
  });
  await transaction.insert(oauthClientResource).values(
    resources.map((resource, index) => ({
      clientId: CLIENT_ID,
      id: `online-repair-link-${index}`,
      resourceId: resource.identifier,
    })),
  );
};

const resourceIdentifiers = async (
  transaction: TestDatabaseTransaction,
): Promise<readonly unknown[]> =>
  (
    await transaction.execute(
      sql`SELECT identifier FROM oauth_resource ORDER BY identifier`,
    )
  ).rows;

const linkedResourceIds = async (
  transaction: TestDatabaseTransaction,
): Promise<readonly unknown[]> =>
  (
    await transaction.execute(sql`
      SELECT resource_id AS "resourceId"
        FROM oauth_client_resource
       WHERE client_id = ${CLIENT_ID}
       ORDER BY resource_id
    `)
  ).rows;

test("the repair is registered, so every deploy runs it", () => {
  // The registry is what makes this automatic. A repair module nobody lists is
  // an operator script with extra steps, which is the defect being fixed.
  expect(ONLINE_MIGRATION_REPAIRS).toContain(BETTER_AUTH_OAUTH_RESOURCE_REPAIR);
  expect(BETTER_AUTH_OAUTH_RESOURCE_REPAIR.name).toBe(
    "better-auth-oauth-resources",
  );
});

test("the deploy repair adds a new audience to an existing database", async () => {
  try {
    await database.transaction(async (transaction) => {
      await givenPreUpgradeDeployment(transaction);
      const connection = onlineConnection(transaction);

      // The pre-upgrade database is consistent with the pre-upgrade code.
      await assertBetterAuthOAuthPolicyCensus(
        transaction,
        preUpgradeResources(),
      );

      // Booting the new image before the repair runs refuses to start, and
      // inserts nothing while refusing.
      expect(
        await captureRejection(
          ensureBetterAuthOAuthPolicy(
            transaction,
            getBetterAuthOAuthResources(),
          ),
        ),
      ).toMatchObject({ failedChecks: ["resources-match"] });
      expect(await resourceIdentifiers(transaction)).not.toContainEqual({
        identifier: lawResourceIdentifier(),
      });

      // The deploy's repair, through the entry the migrator calls.
      await BETTER_AUTH_OAUTH_RESOURCE_REPAIR.repair(connection);
      await BETTER_AUTH_OAUTH_RESOURCE_REPAIR.assertComplete(connection);

      // The boot census the API runs now passes, so the API would serve.
      await ensureBetterAuthOAuthPolicy(
        transaction,
        getBetterAuthOAuthResources(),
      );
      expect(await resourceIdentifiers(transaction)).toContainEqual({
        identifier: lawResourceIdentifier(),
      });
      // And the registration that existed before the upgrade can request it.
      expect(await linkedResourceIds(transaction)).toContainEqual({
        resourceId: lawResourceIdentifier(),
      });

      transaction.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
});

test("a second repair run changes nothing", async () => {
  try {
    await database.transaction(async (transaction) => {
      await givenPreUpgradeDeployment(transaction);
      const connection = onlineConnection(transaction);

      await BETTER_AUTH_OAUTH_RESOURCE_REPAIR.repair(connection);
      const resources = await resourceIdentifiers(transaction);
      const links = await linkedResourceIds(transaction);

      await BETTER_AUTH_OAUTH_RESOURCE_REPAIR.repair(connection);
      await BETTER_AUTH_OAUTH_RESOURCE_REPAIR.assertComplete(connection);

      expect(await resourceIdentifiers(transaction)).toEqual(resources);
      expect(await linkedResourceIds(transaction)).toEqual(links);

      transaction.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
});

test("the repair refuses a conflicting resource definition", async () => {
  try {
    await database.transaction(async (transaction) => {
      await givenPreUpgradeDeployment(transaction);
      const connection = onlineConnection(transaction);
      const [existing] = preUpgradeResources();
      if (existing === undefined) {
        throw new Error("expected a pre-upgrade resource");
      }

      // A stored definition that disagrees with the configured one is never
      // overwritten: the repair refuses, exactly as the cutover command does,
      // so a deploy cannot silently rewrite an audience's scopes.
      await transaction.execute(sql`
        UPDATE oauth_resource
           SET name = 'conflicting resource name'
         WHERE identifier = ${existing.identifier}
      `);

      expect(
        await captureRejection(
          BETTER_AUTH_OAUTH_RESOURCE_REPAIR.repair(connection),
        ),
      ).toBeInstanceOf(Error);
      expect(
        (
          await transaction.execute(sql`
            SELECT name FROM oauth_resource
             WHERE identifier = ${existing.identifier}
          `)
        ).rows,
      ).toEqual([{ name: "conflicting resource name" }]);
      // Refusing leaves the deploy to fail on the completion check rather than
      // on a half-written policy.
      expect(
        await captureRejection(
          BETTER_AUTH_OAUTH_RESOURCE_REPAIR.assertComplete(connection),
        ),
      ).toBeInstanceOf(Error);

      transaction.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
});
