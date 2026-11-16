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
import {
  buildBetterAuthOAuthResources,
  predecessorOAuthResourceScopes,
} from "@/api/mcp/resource-policy-contract";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";
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
      ).toMatchObject({ failedChecks: ["resources-cover-policy"] });
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
        failedChecks: ["resources-cover-policy"],
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

      // A newer release's audience, and the only link of a client that newer
      // release registered, belong to that release's policy. This code does
      // not serve them, and the auth adapter hides them from it, so the boot
      // that has to run beside that release accepts them.
      await transaction.insert(oauthResource).values({
        allowedScopes: ["stella:newer"],
        id: "startup-census-newer-resource",
        identifier: "https://startup-census.example.invalid/newer",
        name: "Newer resource",
      });
      await transaction.insert(oauthClient).values({
        clientId: "startup-census-newer-client",
        id: "startup-census-newer-client-row",
        redirectUris: ["https://client.example.invalid/callback"],
      });
      await transaction.insert(oauthClientResource).values([
        {
          clientId: "startup-census-client",
          id: "startup-census-newer-link",
          resourceId: "https://startup-census.example.invalid/newer",
        },
        {
          clientId: "startup-census-newer-client",
          id: "startup-census-newer-client-link",
          resourceId: "https://startup-census.example.invalid/newer",
        },
      ]);
      await assertBetterAuthOAuthPolicyCensus(transaction, EXPECTED_RESOURCES);

      // A configured resource this code needs still has to be there.
      await transaction.execute(sql`
        DELETE FROM oauth_resource
         WHERE identifier = ${EXPECTED_RESOURCES[1].identifier}
      `);
      const missingResource = await captureCensusRejection(
        assertBetterAuthOAuthPolicyCensus(transaction, EXPECTED_RESOURCES),
      );
      expect(missingResource).toBeInstanceOf(BetterAuthOAuthPolicyCensusError);
      expect(missingResource).toMatchObject({
        failedChecks: ["resources-cover-policy"],
      });

      transaction.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
});

const CONFIGURED_RESOURCES = buildBetterAuthOAuthResources(
  "https://startup-census.example.invalid",
);

/**
 * Stored scope sets for every configured resource, keyed by what the row holds.
 * A row passes when it holds every configured scope: what a newer release
 * added beside them (a scope this code has never heard of, or one this code
 * configures on another audience) is that release's policy, which this code
 * narrows away before it grants anything. A row missing any configured scope
 * fails: the deploy repair has upgraded every `predecessor` row, so one still
 * stored means the repair did not run.
 */
const STORED_SCOPE_SETS = {
  configured: (allowedScopes: readonly string[]) => [...allowedScopes],
  "configured plus a scope a newer release added": (
    allowedScopes: readonly string[],
  ) => [...allowedScopes, "stella:newer_release_scope"],
  "configured plus every configured scope of every audience": () => [
    ...new Set(
      CONFIGURED_RESOURCES.flatMap((resource) => resource.allowedScopes),
    ),
  ],
  predecessor: (allowedScopes: readonly string[]) =>
    predecessorOAuthResourceScopes(allowedScopes),
  "predecessor plus only offline_access": (
    allowedScopes: readonly string[],
  ) => [...predecessorOAuthResourceScopes(allowedScopes), "offline_access"],
  "configured without one resource scope": (allowedScopes: readonly string[]) =>
    allowedScopes.slice(1),
  "configured without one scope, plus a newer one": (
    allowedScopes: readonly string[],
  ) => [...allowedScopes.slice(1), "stella:newer_release_scope"],
  empty: () => [],
} as const;

const ACCEPTED_SCOPE_SETS = new Set<string>([
  "configured",
  "configured plus a scope a newer release added",
  "configured plus every configured scope of every audience",
]);

const givenStoredResources = async (
  transaction: TestDatabaseTransaction,
  storedScopes: (allowedScopes: readonly string[], index: number) => string[],
) => {
  await transaction.execute(sql`
    TRUNCATE oauth_client_resource, oauth_resource, oauth_client CASCADE
  `);
  await transaction.insert(oauthResource).values(
    CONFIGURED_RESOURCES.map((resource, index) => ({
      allowedScopes: storedScopes(resource.allowedScopes, index),
      id: `startup-census-configured-${index}`,
      identifier: resource.identifier,
      name: resource.name,
    })),
  );
};

test("the configured resources differ from their predecessor scope sets", () => {
  // Otherwise every case below would compare a set against itself.
  for (const resource of CONFIGURED_RESOURCES) {
    expect(
      predecessorOAuthResourceScopes(resource.allowedScopes).toSorted(),
    ).not.toEqual([...resource.allowedScopes].toSorted());
    expect(predecessorOAuthResourceScopes(resource.allowedScopes)).not.toEqual(
      [],
    );
  }
});

test.each(Object.entries(STORED_SCOPE_SETS))(
  "the boot census over %s scope rows",
  async (shape, storedScopes) => {
    try {
      await database.transaction(async (transaction) => {
        await givenStoredResources(transaction, storedScopes);
        const outcome = await captureCensusRejection(
          assertBetterAuthOAuthPolicyCensus(transaction, CONFIGURED_RESOURCES),
        );
        if (ACCEPTED_SCOPE_SETS.has(shape)) {
          expect(outcome).toBeNull();
        } else {
          expect(outcome).toBeInstanceOf(BetterAuthOAuthPolicyCensusError);
          expect(outcome).toMatchObject({
            failedChecks: ["resources-cover-policy"],
          });
        }
        transaction.rollback();
      });
    } catch (error) {
      if (!(error instanceof TransactionRollbackError)) {
        throw error;
      }
    }
  },
);

test("the boot census rejects a predecessor row beside configured rows", async () => {
  try {
    await database.transaction(async (transaction) => {
      await givenStoredResources(transaction, (allowedScopes, index) =>
        index === 0
          ? predecessorOAuthResourceScopes(allowedScopes)
          : [...allowedScopes],
      );
      expect(
        await captureCensusRejection(
          assertBetterAuthOAuthPolicyCensus(transaction, CONFIGURED_RESOURCES),
        ),
      ).toMatchObject({ failedChecks: ["resources-cover-policy"] });
      transaction.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
});
