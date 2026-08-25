import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { eq, sql, TransactionRollbackError } from "drizzle-orm";

import { account, oauthClient, user } from "@/api/db/auth-schema";
import { runBetterAuth17Backfill } from "@/api/scripts/better-auth-17-backfill.logic";
import type { BetterAuthBackfillTransaction } from "@/api/scripts/better-auth-17-backfill.logic";
import type { TestDatabase } from "@/api/tests/security/test-utils";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

let database: TestDatabase;

const TEST_RESOURCES = [
  {
    allowedScopes: ["stella:read"],
    identifier: "https://audit.example.invalid/mcp",
    name: "Audit MCP",
  },
  {
    allowedScopes: ["stella:anonymous"],
    identifier: "https://audit.example.invalid/mcp/anonymized",
    name: "Audit anonymized MCP",
  },
] as const;

setDefaultTimeout(120_000);

beforeAll(async () => {
  database = await getTestDb();
});

afterAll(async () => {
  await releaseTestDb();
});

test("the Better Auth bridge backfill is exact, bounded, and reaches a fixed point", async () => {
  try {
    await database.transaction(async (transaction) => {
      const suffix = Bun.randomUUIDv7();
      const userId = `backfill-user-${suffix}`;
      const credentialRowId = `backfill-credential-${suffix}`;
      const googleRowId = `backfill-google-${suffix}`;
      const microsoftRowId = `backfill-microsoft-${suffix}`;
      const microsoftLegacySub = `microsoft-legacy-${suffix}`;
      const microsoftOid = "71c02436-6600-42fd-84d0-417484a177b0";
      const microsoftIssuer =
        "https://login.microsoftonline.com/3a893563-0d4e-4309-9a31-b6e4e9f64479/v2.0";
      const clientId = `backfill-client-${suffix}`;

      // The shared test schema represents the final 1.7 state. Relax only the
      // final constraint inside this rollback-only transaction to recreate the
      // additive bridge state the backfill consumes.
      await transaction.execute(sql`
        ALTER TABLE account ALTER COLUMN issuer DROP NOT NULL
      `);

      await transaction.insert(user).values({
        email: `backfill-${suffix}@example.invalid`,
        id: userId,
        name: "Backfill fixture",
      });
      await transaction.execute(sql`
        INSERT INTO account (id, account_id, provider_id, user_id, updated_at)
        VALUES
          (${credentialRowId}, ${userId}, 'credential', ${userId}, now()),
          (${googleRowId}, ${`google-sub-${suffix}`}, 'google', ${userId}, now()),
          (${microsoftRowId}, ${microsoftLegacySub}, 'microsoft', ${userId}, now())
      `);
      await transaction.insert(oauthClient).values({
        clientId,
        grantTypes: ["client_credentials"],
        id: `backfill-client-row-${suffix}`,
        public: false,
        redirectUris: ["https://client.example.invalid/callback"],
        scopes: ["openid", "offline_access", "stella:read"],
        type: "web",
      });

      const backfillDatabase = {
        transaction: async <T>(
          callback: (nested: BetterAuthBackfillTransaction) => Promise<T>,
        ) =>
          await transaction.transaction(
            async (nested) =>
              await callback({
                execute: async (statement) => await nested.execute(statement),
              }),
          ),
      };
      const options = {
        batchSize: 1,
        database: backfillDatabase,
        expectedOAuthResources: TEST_RESOURCES,
        trustedIdentityMap: {
          formatVersion: 1,
          microsoftAccounts: [
            {
              accountId: microsoftOid,
              accountRowId: microsoftRowId,
              issuer: microsoftIssuer,
              legacyAccountId: microsoftLegacySub,
            },
          ],
        },
      } as const;

      const first = await runBetterAuth17Backfill(options);
      if (first.status === "error") {
        throw first.error.cause ?? first.error;
      }
      expect(first).toMatchObject({ status: "ok", value: { changed: true } });
      const second = await runBetterAuth17Backfill(options);
      expect(second).toMatchObject({
        status: "ok",
        value: { changed: false },
      });

      const identities = await transaction.execute(sql`
        SELECT id, issuer, account_id AS "accountId"
          FROM account
         WHERE id IN (${credentialRowId}, ${googleRowId}, ${microsoftRowId})
         ORDER BY id
      `);
      expect(identities.rows).toEqual([
        {
          accountId: userId,
          id: credentialRowId,
          issuer: "local:credential",
        },
        {
          accountId: `google-sub-${suffix}`,
          id: googleRowId,
          issuer: "https://accounts.google.com",
        },
        {
          accountId: microsoftOid,
          id: microsoftRowId,
          issuer: microsoftIssuer,
        },
      ]);

      const clientPolicy = await transaction.execute(sql`
        SELECT application_type AS "applicationType",
               client_credentials_scopes AS "clientCredentialsScopes",
               ARRAY(
                 SELECT resource_id
                   FROM oauth_client_resource
                  WHERE client_id = ${clientId}
                  ORDER BY resource_id
               ) AS resources
          FROM oauth_client
         WHERE client_id = ${clientId}
      `);
      expect(clientPolicy.rows).toEqual([
        {
          applicationType: "web",
          clientCredentialsScopes: ["stella:read"],
          resources: TEST_RESOURCES.map(
            ({ identifier }) => identifier,
          ).toSorted(),
        },
      ]);

      await transaction
        .update(account)
        .set({ accountId: "untrusted-microsoft-subject" })
        .where(eq(account.id, microsoftRowId));
      const rollbackResourceIdentifier = `https://audit.example.invalid/mcp/rollback-${suffix}`;
      expect(
        await runBetterAuth17Backfill({
          ...options,
          expectedOAuthResources: [
            ...TEST_RESOURCES,
            {
              allowedScopes: ["stella:rollback"],
              identifier: rollbackResourceIdentifier,
              name: "Rollback proof",
            },
          ],
        }),
      ).toMatchObject({
        error: { code: "invalid-source-state" },
        status: "error",
      });
      const rolledBackResources = await transaction.execute(sql`
        SELECT identifier
          FROM oauth_resource
         WHERE identifier = ${rollbackResourceIdentifier}
      `);
      expect(rolledBackResources.rows).toEqual([]);

      transaction.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
});
