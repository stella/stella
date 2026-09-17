import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { sql, TransactionRollbackError } from "drizzle-orm";

import { compareCodeUnit } from "@stll/collation";

import {
  oauthClient,
  oauthClientResource,
  oauthResource,
} from "@/api/db/auth-schema";
import {
  assertBetterAuthOAuthPolicyCensus,
  BetterAuthOAuthPolicyCensusError,
  ensureBetterAuthOAuthPolicy,
} from "@/api/lib/db/better-auth-oauth-policy-census";
import { runBetterAuth17BackfillInTransaction } from "@/api/scripts/better-auth-17-backfill.logic";
import type { TestDatabase } from "@/api/tests/security/test-utils";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

let database: TestDatabase;

const EXPECTED_RESOURCES = [
  {
    allowedScopes: ["stella:read"],
    identifier: "https://startup-census.example.invalid/mcp",
    name: "Startup census MCP",
  },
  {
    allowedScopes: ["stella:anonymous"],
    identifier: "https://startup-census.example.invalid/mcp/anonymized",
    name: "Startup census anonymized MCP",
  },
] as const;

setDefaultTimeout(120_000);

beforeAll(async () => {
  database = await getTestDb();
});

afterAll(async () => {
  await releaseTestDb();
});

const captureCensusRejection = async (
  operation: Promise<void>,
): Promise<unknown> =>
  await operation.then(
    () => null,
    (error: unknown) => error,
  );

test("startup initializes only a pristine Better Auth database", async () => {
  try {
    await database.transaction(async (transaction) => {
      await transaction.execute(sql`
        TRUNCATE "user", account, oauth_client_resource, oauth_resource,
                 oauth_client CASCADE
      `);

      await ensureBetterAuthOAuthPolicy(transaction, EXPECTED_RESOURCES);
      await ensureBetterAuthOAuthPolicy(transaction, EXPECTED_RESOURCES);
      const initialized = await transaction.execute(sql`
        SELECT identifier
          FROM oauth_resource
         ORDER BY identifier
      `);
      expect(initialized.rows).toEqual(
        EXPECTED_RESOURCES.map(({ identifier }) => ({ identifier })).toSorted(
          (left, right) => compareCodeUnit(left.identifier, right.identifier),
        ),
      );

      await transaction.execute(sql`TRUNCATE oauth_resource CASCADE`);
      await transaction.execute(sql`
        INSERT INTO "user" (id, name, email, email_verified)
        VALUES (
          'startup-census-existing-user',
          'Existing user',
          'startup-census@example.invalid',
          false
        )
      `);
      expect(
        await captureCensusRejection(
          ensureBetterAuthOAuthPolicy(transaction, EXPECTED_RESOURCES),
        ),
      ).toMatchObject({ failedChecks: ["resources-match"] });
      const resourcesAfterRejection = await transaction.execute(sql`
        SELECT identifier FROM oauth_resource
      `);
      expect(resourcesAfterRejection.rows).toEqual([]);

      transaction.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
});

test("startup rejects incomplete Better Auth OAuth resource migrations", async () => {
  try {
    await database.transaction(async (transaction) => {
      await transaction.execute(sql`
        TRUNCATE oauth_client_resource, oauth_resource, oauth_client CASCADE
      `);
      await transaction.insert(oauthResource).values(
        EXPECTED_RESOURCES.map((resource, index) => ({
          ...resource,
          allowedScopes: [...resource.allowedScopes],
          id: `startup-census-resource-${index}`,
        })),
      );
      await transaction.insert(oauthClient).values({
        clientId: "startup-census-client",
        id: "startup-census-client-row",
        redirectUris: ["https://client.example.invalid/callback"],
      });
      await transaction.insert(oauthClientResource).values({
        clientId: "startup-census-client",
        id: "startup-census-link",
        resourceId: EXPECTED_RESOURCES[0].identifier,
      });

      // A deliberate resource subset is valid for post-migration clients.
      await assertBetterAuthOAuthPolicyCensus(transaction, EXPECTED_RESOURCES);

      await transaction.execute(sql`
        UPDATE oauth_resource
           SET name = 'unexpected resource name'
         WHERE identifier = ${EXPECTED_RESOURCES[0].identifier}
      `);
      expect(
        await captureCensusRejection(
          assertBetterAuthOAuthPolicyCensus(transaction, EXPECTED_RESOURCES),
        ),
      ).toMatchObject({
        failedChecks: ["resources-match"],
        message: "Better Auth OAuth policy migration is incomplete",
      });
      await transaction.execute(sql`
        UPDATE oauth_resource
           SET name = ${EXPECTED_RESOURCES[0].name}
         WHERE identifier = ${EXPECTED_RESOURCES[0].identifier}
      `);

      await transaction.execute(sql`
        DELETE FROM oauth_client_resource
         WHERE client_id = 'startup-census-client'
      `);
      expect(
        await captureCensusRejection(
          assertBetterAuthOAuthPolicyCensus(transaction, EXPECTED_RESOURCES),
        ),
      ).toMatchObject({ failedChecks: ["clients-linked"] });

      await transaction.insert(oauthResource).values({
        allowedScopes: ["stella:unexpected"],
        id: "startup-census-unexpected-resource",
        identifier: "https://startup-census.example.invalid/unexpected",
        name: "Unexpected resource",
      });
      await transaction.insert(oauthClientResource).values({
        clientId: "startup-census-client",
        id: "startup-census-unexpected-link",
        resourceId: "https://startup-census.example.invalid/unexpected",
      });
      const unexpectedLink = await captureCensusRejection(
        assertBetterAuthOAuthPolicyCensus(transaction, EXPECTED_RESOURCES),
      );
      expect(unexpectedLink).toBeInstanceOf(BetterAuthOAuthPolicyCensusError);
      expect(unexpectedLink).toMatchObject({
        failedChecks: ["resources-match", "links-use-configured-resources"],
      });

      transaction.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
});

// A new MCP audience widens `buildBetterAuthOAuthResources`. Startup does not
// repair an existing database: `initializePristineBetterAuthOAuthPolicy` is a
// no-op unless the whole auth database is empty, so the API fails closed until
// the deployment backfill has seeded the row. This pins both halves of that
// ordering, because the failure mode is a boot failure on upgrade.
test("a new audience reaches an existing database through the backfill, not startup", async () => {
  const ADDED_RESOURCE = {
    allowedScopes: ["stella:search", "stella:read"],
    identifier: "https://startup-census.example.invalid/mcp-law",
    name: "Startup census law MCP",
  } as const;
  const UPGRADED_RESOURCES = [...EXPECTED_RESOURCES, ADDED_RESOURCE] as const;

  try {
    await database.transaction(async (transaction) => {
      await transaction.execute(sql`
        TRUNCATE "user", account, oauth_client_resource, oauth_resource,
                 oauth_client CASCADE
      `);

      // The pre-upgrade deployment: the resources it already serves, and a
      // registration linked to them.
      await transaction.insert(oauthResource).values(
        EXPECTED_RESOURCES.map((resource, index) => ({
          ...resource,
          allowedScopes: [...resource.allowedScopes],
          id: `startup-census-upgrade-resource-${index}`,
        })),
      );
      await transaction.insert(oauthClient).values({
        clientId: "startup-census-upgrade-client",
        id: "startup-census-upgrade-client-row",
        redirectUris: ["https://client.example.invalid/callback"],
      });
      await transaction.insert(oauthClientResource).values(
        EXPECTED_RESOURCES.map((resource, index) => ({
          clientId: "startup-census-upgrade-client",
          id: `startup-census-upgrade-link-${index}`,
          resourceId: resource.identifier,
        })),
      );
      await assertBetterAuthOAuthPolicyCensus(transaction, EXPECTED_RESOURCES);

      // Booting the new image before the backfill runs refuses to start, and
      // inserts nothing while refusing.
      expect(
        await captureCensusRejection(
          ensureBetterAuthOAuthPolicy(transaction, UPGRADED_RESOURCES),
        ),
      ).toMatchObject({ failedChecks: ["resources-match"] });
      const resourcesAfterBoot = await transaction.execute(sql`
        SELECT identifier FROM oauth_resource ORDER BY identifier
      `);
      expect(resourcesAfterBoot.rows).not.toContainEqual({
        identifier: ADDED_RESOURCE.identifier,
      });

      // The deployment backfill owns resource creation, and links every
      // existing registration to the new audience so a client issued before
      // the upgrade can still request it.
      const backfilled = await runBetterAuth17BackfillInTransaction({
        batchSize: 100,
        expectedOAuthResources: UPGRADED_RESOURCES,
        transaction,
        trustedIdentityMap: { formatVersion: 1, microsoftAccounts: [] },
      });
      expect(backfilled.status).toBe("ok");

      await assertBetterAuthOAuthPolicyCensus(transaction, UPGRADED_RESOURCES);
      const links = await transaction.execute(sql`
        SELECT resource_id AS "resourceId"
          FROM oauth_client_resource
         WHERE client_id = 'startup-census-upgrade-client'
         ORDER BY resource_id
      `);
      expect(links.rows).toContainEqual({
        resourceId: ADDED_RESOURCE.identifier,
      });

      transaction.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
});
