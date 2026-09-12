import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { sql, TransactionRollbackError } from "drizzle-orm";

import { account, oauthClient, user } from "@/api/db/auth-schema";
import {
  AUTH_BASELINE_MODEL_NAMES,
  AUTH_TABLE_AUDIT_POLICY,
  BETTER_AUTH_AUDIT_CHECKS,
  BETTER_AUTH_AUDIT_MODES,
  parseBetterAuthAuditBaseline,
  runBetterAuthAccountKeyAudit,
} from "@/api/scripts/better-auth-migration-audit.logic";
import type { TestDatabase } from "@/api/tests/security/test-utils";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

let database: TestDatabase;

const TEST_OAUTH_RESOURCES = [
  {
    allowedScopes: ["stella:read"],
    identifier: "https://account-key-audit.example.invalid/mcp",
    name: "Account key audit resource",
  },
] as const;

setDefaultTimeout(120_000);

beforeAll(async () => {
  database = await getTestDb();
});

afterAll(async () => {
  await releaseTestDb();
});

const checkStatus = (
  result: Awaited<ReturnType<typeof runBetterAuthAccountKeyAudit>>,
  name: string,
) => {
  if (result.status === "error") {
    return "query-error";
  }
  return result.value.report.checks.find((check) => check.name === name)
    ?.status;
};

test("freezes a 1.7.1 account census and accepts the 1.7.3 key transition", async () => {
  try {
    await database.transaction(async (transaction) => {
      const suffix = Bun.randomUUIDv7();
      const userId = `account-key-user-${suffix}`;
      const microsoftId = `account-key-microsoft-${suffix}`;
      const clientId = `account-key-client-${suffix}`;
      await transaction.insert(user).values({
        id: userId,
        email: `${suffix}@example.invalid`,
        name: "Account key audit fixture",
      });
      await transaction.insert(account).values([
        {
          id: `account-key-credential-${suffix}`,
          accountId: userId,
          providerId: "credential",
          userId,
          issuer: "local:credential",
        },
        {
          id: `account-key-microsoft-row-${suffix}`,
          accountId: microsoftId,
          providerId: "microsoft",
          userId,
          issuer:
            "https://login.microsoftonline.com/3a893563-0d4e-4309-9a31-b6e4e9f64479/v2.0",
        },
      ]);
      await transaction.insert(oauthClient).values({
        id: `account-key-client-row-${suffix}`,
        clientId,
        public: true,
        redirectUris: [`https://${suffix}.example.invalid/callback`],
        tokenEndpointAuthMethod: "none",
        type: "web",
      });
      await transaction.execute(sql`
        UPDATE oauth_client
           SET application_type = 'native',
               client_credentials_scopes = ARRAY['stella:read']::text[]
         WHERE client_id = ${clientId}
      `);
      await transaction.execute(sql`
        INSERT INTO oauth_resource (id, identifier, name, allowed_scopes)
        VALUES (
          ${`account-key-resource-${suffix}`},
          ${TEST_OAUTH_RESOURCES[0].identifier},
          ${TEST_OAUTH_RESOURCES[0].name},
          ARRAY['stella:read']::text[]
        )
      `);
      await transaction.execute(sql`
        INSERT INTO oauth_client_resource (id, client_id, resource_id)
        VALUES (
          ${`account-key-link-${suffix}`},
          ${clientId},
          ${TEST_OAUTH_RESOURCES[0].identifier}
        )
      `);

      await transaction.execute(
        sql`ALTER TABLE account ALTER COLUMN issuer SET NOT NULL`,
      );
      await transaction.execute(sql`
        CREATE UNIQUE INDEX account_issuer_account_id_uidx
          ON account (issuer, account_id)
      `);
      const db = {
        execute: async (statement: Parameters<typeof transaction.execute>[0]) =>
          await transaction.execute(statement),
      };
      const pre = await runBetterAuthAccountKeyAudit({
        baseline: null,
        database: db,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.PRE_ACCOUNT_KEY,
      });
      expect(pre.status).toBe("ok");
      if (pre.status === "error") {
        throw pre.error;
      }
      expect(pre.value.report.status).toBe("passed");
      expect(parseBetterAuthAuditBaseline(pre.value.baseline).status).toBe(
        "ok",
      );
      const historicalPayload = {
        ...pre.value.baseline,
        tables: Object.fromEntries(
          AUTH_BASELINE_MODEL_NAMES.map((model) => [
            model,
            {
              ...pre.value.baseline.tables[model],
              preservedColumns: AUTH_TABLE_AUDIT_POLICY[model].preservedColumns,
            },
          ]),
        ),
      };
      const historical = parseBetterAuthAuditBaseline(historicalPayload);
      expect(historical.status).toBe("ok");

      await transaction.execute(
        sql`ALTER TABLE account ALTER COLUMN issuer DROP NOT NULL`,
      );
      await transaction.execute(sql`DROP INDEX account_issuer_account_id_uidx`);
      if (historical.status === "error") {
        throw historical.error;
      }
      const historicalPost = await runBetterAuthAccountKeyAudit({
        baseline: historical.value,
        database: db,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.POST_ACCOUNT_KEY,
      });
      expect(
        checkStatus(
          historicalPost,
          BETTER_AUTH_AUDIT_CHECKS.AUTH_ROWS_PRESERVED,
        ),
      ).toBe("failed");
      const post = await runBetterAuthAccountKeyAudit({
        baseline: pre.value.baseline,
        database: db,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.POST_ACCOUNT_KEY,
      });
      expect(post.status).toBe("ok");
      if (post.status === "error") {
        throw post.error;
      }
      expect(post.value.report.status).toBe("passed");
      expect(post.value.baseline).toEqual(pre.value.baseline);

      await transaction.execute(sql`
        UPDATE account
           SET issuer = 'https://issuer-changed.example.invalid'
         WHERE id = ${`account-key-credential-${suffix}`}
      `);
      const changedIssuer = await runBetterAuthAccountKeyAudit({
        baseline: pre.value.baseline,
        database: db,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.POST_ACCOUNT_KEY,
      });
      expect(
        checkStatus(
          changedIssuer,
          BETTER_AUTH_AUDIT_CHECKS.AUTH_ROWS_PRESERVED,
        ),
      ).toBe("failed");
      await transaction.execute(
        sql`UPDATE account SET issuer = 'local:credential' WHERE id = ${`account-key-credential-${suffix}`}`,
      );

      await transaction.execute(sql`
        UPDATE account
           SET account_id = 'microsoft-account-id-changed'
         WHERE id = ${`account-key-microsoft-row-${suffix}`}
      `);
      const changedMicrosoftId = await runBetterAuthAccountKeyAudit({
        baseline: pre.value.baseline,
        database: db,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.POST_ACCOUNT_KEY,
      });
      expect(
        checkStatus(
          changedMicrosoftId,
          BETTER_AUTH_AUDIT_CHECKS.AUTH_ROWS_PRESERVED,
        ),
      ).toBe("failed");
      await transaction.execute(
        sql`UPDATE account SET account_id = ${microsoftId} WHERE id = ${`account-key-microsoft-row-${suffix}`}`,
      );

      await transaction.execute(
        sql`UPDATE oauth_client SET application_type = 'web' WHERE client_id = ${clientId}`,
      );
      const changedOAuthPolicy = await runBetterAuthAccountKeyAudit({
        baseline: pre.value.baseline,
        database: db,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.POST_ACCOUNT_KEY,
      });
      expect(
        checkStatus(
          changedOAuthPolicy,
          BETTER_AUTH_AUDIT_CHECKS.AUTH_ROWS_PRESERVED,
        ),
      ).toBe("failed");
      await transaction.execute(
        sql`UPDATE oauth_client SET application_type = 'native' WHERE client_id = ${clientId}`,
      );

      await transaction.insert(account).values({
        id: `account-key-null-issuer-${suffix}`,
        accountId: `new-null-issuer-${suffix}`,
        providerId: "google",
        userId,
        issuer: null,
      });
      const nullIssuer = await runBetterAuthAccountKeyAudit({
        baseline: pre.value.baseline,
        database: db,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.POST_ACCOUNT_KEY,
      });
      expect(nullIssuer.status).toBe("ok");
      if (nullIssuer.status === "error") {
        throw nullIssuer.error;
      }
      expect(nullIssuer.value.report.status).toBe("failed");
      expect(
        checkStatus(nullIssuer, BETTER_AUTH_AUDIT_CHECKS.AUTH_ROWS_PRESERVED),
      ).toBe("failed");
      throw new TransactionRollbackError();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
});

test("rejects account-key preconditions and every frozen data or policy change", async () => {
  try {
    await database.transaction(async (transaction) => {
      const suffix = Bun.randomUUIDv7();
      const userId = `account-key-invalid-user-${suffix}`;
      await transaction.insert(user).values({
        id: userId,
        email: `${suffix}@example.invalid`,
        name: "Account key invalid fixture",
      });
      await transaction.insert(account).values({
        id: `account-key-invalid-row-${suffix}`,
        accountId: userId,
        providerId: "credential",
        userId,
        issuer: "local:credential",
      });
      await transaction.insert(account).values({
        id: `account-key-google-${suffix}`,
        accountId: `same-google-account-${suffix}`,
        providerId: "google",
        userId,
        issuer: "https://accounts.google.com/a",
      });
      await transaction.execute(
        sql`ALTER TABLE account ALTER COLUMN issuer SET NOT NULL`,
      );
      await transaction.execute(
        sql`DROP INDEX IF EXISTS account_issuer_account_id_uidx`,
      );
      const db = {
        execute: async (statement: Parameters<typeof transaction.execute>[0]) =>
          await transaction.execute(statement),
      };
      const missing = await runBetterAuthAccountKeyAudit({
        baseline: null,
        database: db,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.PRE_ACCOUNT_KEY,
      });
      expect(
        checkStatus(
          missing,
          BETTER_AUTH_AUDIT_CHECKS.FINAL_ACCOUNT_CONSTRAINTS,
        ),
      ).toBe("failed");
      await transaction.execute(sql`
        CREATE UNIQUE INDEX account_issuer_account_id_uidx
          ON account (issuer, account_id)
        WHERE issuer IS NOT NULL
      `);
      const partial = await runBetterAuthAccountKeyAudit({
        baseline: null,
        database: db,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.PRE_ACCOUNT_KEY,
      });
      expect(
        checkStatus(
          partial,
          BETTER_AUTH_AUDIT_CHECKS.FINAL_ACCOUNT_CONSTRAINTS,
        ),
      ).toBe("failed");
      await transaction.execute(sql`DROP INDEX account_issuer_account_id_uidx`);
      await transaction.execute(
        sql`CREATE UNIQUE INDEX account_issuer_account_id_uidx ON account (issuer, account_id)`,
      );

      await transaction.execute(
        sql`DROP INDEX account_provider_account_id_uidx`,
      );
      await transaction.execute(sql`
        INSERT INTO account (id, account_id, provider_id, user_id, issuer, updated_at)
        VALUES (${`account-key-duplicate-${suffix}`}, ${`same-google-account-${suffix}`}, 'google', ${userId}, 'https://accounts.google.com/b', now())
      `);
      const duplicate = await runBetterAuthAccountKeyAudit({
        baseline: null,
        database: db,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.PRE_ACCOUNT_KEY,
      });
      expect(
        checkStatus(duplicate, BETTER_AUTH_AUDIT_CHECKS.ACCOUNT_KEY_UNIQUE),
      ).toBe("failed");
      throw new TransactionRollbackError();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
});
