import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { sql, TransactionRollbackError } from "drizzle-orm";

import {
  oauthClient,
  oauthClientResource,
  oauthResource,
} from "@/api/db/auth-schema";
import {
  assertBetterAuthOAuthPolicyCensus,
  BetterAuthOAuthPolicyCensusError,
} from "@/api/lib/db/better-auth-oauth-policy-census";
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
