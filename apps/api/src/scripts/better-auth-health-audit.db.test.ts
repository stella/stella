import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { sql, TransactionRollbackError } from "drizzle-orm";

import { account, oauthClient, user } from "@/api/db/auth-schema";
import {
  BETTER_AUTH_AUDIT_CHECKS,
  renderBetterAuthAuditReport,
  runBetterAuthHealthAudit,
} from "@/api/scripts/better-auth-migration-audit.logic";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

let database: TestDatabase;

const TEST_RESOURCES = [
  {
    allowedScopes: ["stella:read"],
    identifier: "https://health-audit.example.invalid/mcp",
    name: "Health audit resource",
  },
] as const;

setDefaultTimeout(120_000);

beforeAll(async () => {
  database = await getTestDb();
});

afterAll(async () => {
  await releaseTestDb();
});

const withFixture = async (
  verifyFixture: (transaction: TestDatabaseTransaction) => Promise<void>,
) => {
  try {
    await database.transaction(async (transaction) => {
      const suffix = Bun.randomUUIDv7();
      const userId = `health-user-${suffix}`;
      await transaction.insert(user).values({
        id: userId,
        email: `${suffix}@example.invalid`,
        name: "Health audit fixture",
      });
      await transaction.insert(account).values([
        {
          id: `health-account-null-${suffix}`,
          accountId: `health-null-${suffix}`,
          providerId: "google",
          userId,
          issuer: null,
        },
        {
          id: `health-account-history-${suffix}`,
          accountId: `health-history-${suffix}`,
          providerId: "microsoft",
          userId,
          issuer: "https://issuer.example.invalid/legacy",
        },
      ]);
      await transaction.execute(sql`
        INSERT INTO oauth_resource (id, identifier, name, allowed_scopes)
        VALUES (
          ${`health-resource-row-${suffix}`},
          ${TEST_RESOURCES[0].identifier},
          ${TEST_RESOURCES[0].name},
          ARRAY['stella:read']::text[]
        )
        ON CONFLICT (identifier) DO UPDATE
          SET name = EXCLUDED.name, allowed_scopes = EXCLUDED.allowed_scopes
      `);
      const clientId = `health-client-${suffix}`;
      await transaction.insert(oauthClient).values({
        id: `health-client-row-${suffix}`,
        clientId,
        public: true,
        redirectUris: [`https://health-${suffix}.example.invalid/callback`],
        tokenEndpointAuthMethod: "none",
        type: "web",
      });
      await transaction.execute(sql`
        UPDATE oauth_client
           SET application_type = 'web'
         WHERE client_id = ${clientId}
      `);
      await transaction.execute(sql`
        INSERT INTO oauth_client_resource (id, client_id, resource_id)
        VALUES (${`health-link-${suffix}`}, ${clientId}, ${TEST_RESOURCES[0].identifier})
      `);

      await verifyFixture(transaction);
      transaction.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
};

const checkStatus = (
  result: Awaited<ReturnType<typeof runBetterAuthHealthAudit>>,
  name: string,
) => {
  if (result.status === "error") {
    return "query-error";
  }
  return result.value.checks.find((check) => check.name === name)?.status;
};

const audit = async (transaction: TestDatabaseTransaction) =>
  await runBetterAuthHealthAudit({
    database: {
      execute: async (statement) => await transaction.execute(statement),
    },
    expectedOAuthResources: TEST_RESOURCES,
  });

test("health audit accepts NULL issuers and is repeatable without exposing rows", async () => {
  await withFixture(async (transaction) => {
    const first = await audit(transaction);
    const second = await audit(transaction);

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    if (first.status === "ok" && second.status === "ok") {
      expect(first.value.status).toBe("passed");
      expect(second.value).toEqual(first.value);
      expect(renderBetterAuthAuditReport(first.value)).not.toContain(
        "health-user-",
      );
      expect(
        checkStatus(first, BETTER_AUTH_AUDIT_CHECKS.ACCOUNT_KEY_UNIQUE),
      ).toBe("passed");
      expect(
        checkStatus(first, BETTER_AUTH_AUDIT_CHECKS.FINAL_ACCOUNT_CONSTRAINTS),
      ).toBe("passed");
    }
  });
});

test("health audit rejects duplicate account keys and incomplete indexes", async () => {
  await withFixture(async (transaction) => {
    await transaction.execute(sql`DROP INDEX account_provider_account_id_uidx`);
    const missing = await audit(transaction);
    expect(
      checkStatus(missing, BETTER_AUTH_AUDIT_CHECKS.FINAL_ACCOUNT_CONSTRAINTS),
    ).toBe("failed");

    await transaction.execute(sql`
      CREATE UNIQUE INDEX account_provider_account_id_uidx
        ON account (provider_id, account_id)
        WHERE provider_id IS NOT NULL
    `);
    const partial = await audit(transaction);
    expect(
      checkStatus(partial, BETTER_AUTH_AUDIT_CHECKS.FINAL_ACCOUNT_CONSTRAINTS),
    ).toBe("failed");

    await transaction.execute(sql`DROP INDEX account_provider_account_id_uidx`);
    await transaction.execute(sql`
      INSERT INTO account (id, account_id, provider_id, user_id, issuer, updated_at)
      SELECT 'health-duplicate', account_id, provider_id, user_id, 'other-issuer', now()
      FROM account
      WHERE provider_id = 'google' AND account_id LIKE 'health-null-%'
      LIMIT 1
    `);
    const duplicate = await audit(transaction);
    expect(
      checkStatus(duplicate, BETTER_AUTH_AUDIT_CHECKS.ACCOUNT_KEY_UNIQUE),
    ).toBe("failed");
    expect(
      checkStatus(
        duplicate,
        BETTER_AUTH_AUDIT_CHECKS.FINAL_ACCOUNT_CONSTRAINTS,
      ),
    ).toBe("failed");
  });
});

test("health audit rejects foreign-key orphans, missing constraints, and disabled RLS", async () => {
  await withFixture(async (transaction) => {
    await transaction.execute(sql`
      ALTER TABLE account DROP CONSTRAINT account_user_id_user_id_fkey
    `);
    await transaction.execute(sql`
      INSERT INTO account (id, account_id, provider_id, user_id, issuer, updated_at)
      VALUES ('health-orphan', 'health-orphan', 'google', 'missing-health-user', NULL, now())
    `);
    const orphan = await audit(transaction);
    expect(
      checkStatus(orphan, BETTER_AUTH_AUDIT_CHECKS.AUTH_FOREIGN_KEYS_REACHABLE),
    ).toBe("failed");
    expect(
      checkStatus(orphan, BETTER_AUTH_AUDIT_CHECKS.AUTH_FOREIGN_KEYS_VALIDATED),
    ).toBe("failed");

    await transaction.execute(
      sql`ALTER TABLE account DISABLE ROW LEVEL SECURITY`,
    );
    const disabledRls = await audit(transaction);
    expect(
      checkStatus(disabledRls, BETTER_AUTH_AUDIT_CHECKS.AUTH_ACCESS_BOUNDARIES),
    ).toBe("failed");
  });
});

test("health audit stops with a failed schema check when a runtime column is missing", async () => {
  await withFixture(async (transaction) => {
    await transaction.execute(sql`
      ALTER TABLE account RENAME COLUMN issuer TO issuer_health_missing
    `);
    const result = await audit(transaction);

    expect(result.status).toBe("ok");
    expect(
      checkStatus(result, BETTER_AUTH_AUDIT_CHECKS.CURRENT_SCHEMA_COMPLETE),
    ).toBe("failed");
    expect(
      checkStatus(result, BETTER_AUTH_AUDIT_CHECKS.ACCOUNT_KEY_UNIQUE),
    ).toBe(undefined);
  });
});
