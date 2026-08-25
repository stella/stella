import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { eq, sql, TransactionRollbackError } from "drizzle-orm";

import { account, oauthClient, session, user } from "@/api/db/auth-schema";
import {
  BETTER_AUTH_AUDIT_CHECKS,
  BETTER_AUTH_AUDIT_MODES,
  runBetterAuthMigrationAudit,
} from "@/api/scripts/better-auth-migration-audit.logic";
import type { TestDatabase } from "@/api/tests/security/test-utils";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

let database: TestDatabase;

const EMPTY_TRUSTED_IDENTITY_MAP = {
  formatVersion: 1,
  microsoftAccounts: [],
} as const;

const TEST_OAUTH_RESOURCES = [
  {
    allowedScopes: ["stella:read"],
    identifier: "https://audit.example.invalid/mcp",
    name: "Audit resource",
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
  report: Awaited<ReturnType<typeof runBetterAuthMigrationAudit>>,
  name: string,
) => {
  if (report.status === "error") {
    return "query-error";
  }
  return report.value.report.checks.find((check) => check.name === name)
    ?.status;
};

test("pre-migration audit is repeatable and rejects ownership corruption and an orphan", async () => {
  try {
    await database.transaction(async (transaction) => {
      const suffix = Bun.randomUUIDv7();
      const userId = `audit-user-${suffix}`;
      const accountId = `audit-account-${suffix}`;
      const sessionId = `audit-session-${suffix}`;
      await transaction.execute(sql`
        ALTER TABLE account ALTER COLUMN issuer DROP NOT NULL
      `);
      await transaction.insert(user).values({
        id: userId,
        email: `audit-${suffix}@example.invalid`,
        name: "Audit fixture",
      });
      await transaction.execute(sql`
        INSERT INTO account (id, account_id, provider_id, user_id, updated_at)
        VALUES (${accountId}, ${userId}, 'credential', ${userId}, now())
      `);
      await transaction.insert(session).values({
        id: sessionId,
        expiresAt: new Date(Date.now() + 60_000),
        token: `audit-token-${suffix}`,
        updatedAt: new Date(),
        userId,
      });

      const auditDatabase = {
        execute: async (statement: Parameters<typeof transaction.execute>[0]) =>
          await transaction.execute(statement),
      };
      const first = await runBetterAuthMigrationAudit({
        baseline: null,
        database: auditDatabase,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION,
        trustedIdentityMap: EMPTY_TRUSTED_IDENTITY_MAP,
      });
      if (first.status === "error") {
        throw first.error;
      }
      expect(first.status).toBe("ok");
      expect(first.value.report.status).toBe("passed");

      const second = await runBetterAuthMigrationAudit({
        baseline: null,
        database: auditDatabase,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION,
        trustedIdentityMap: EMPTY_TRUSTED_IDENTITY_MAP,
      });
      if (second.status === "error") {
        throw second.error;
      }
      expect(second.status).toBe("ok");
      expect(second.value.baseline).toEqual(first.value.baseline);

      await transaction.execute(sql`
        ALTER POLICY auth_no_stella_access ON account
          USING (true)
          WITH CHECK (true)
      `);
      await transaction
        .update(account)
        .set({ accountId: `wrong-owner-${suffix}` })
        .where(eq(account.id, accountId));
      const corruptedAccessAndOwnership = await runBetterAuthMigrationAudit({
        baseline: null,
        database: auditDatabase,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION,
        trustedIdentityMap: EMPTY_TRUSTED_IDENTITY_MAP,
      });
      expect(
        checkStatus(
          corruptedAccessAndOwnership,
          BETTER_AUTH_AUDIT_CHECKS.AUTH_ACCESS_BOUNDARIES,
        ),
      ).toBe("failed");
      expect(
        checkStatus(
          corruptedAccessAndOwnership,
          BETTER_AUTH_AUDIT_CHECKS.CREDENTIAL_ACCOUNT_OWNERSHIP,
        ),
      ).toBe("failed");
      await transaction.execute(sql`
        ALTER POLICY auth_no_stella_access ON account
          USING (false)
          WITH CHECK (false)
      `);

      await transaction
        .update(account)
        .set({ accountId: userId })
        .where(eq(account.id, accountId));
      await transaction.execute(
        sql`ALTER TABLE "session" DROP CONSTRAINT "session_user_id_user_id_fkey"`,
      );
      const missingForeignKey = await runBetterAuthMigrationAudit({
        baseline: null,
        database: auditDatabase,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION,
        trustedIdentityMap: EMPTY_TRUSTED_IDENTITY_MAP,
      });
      expect(
        checkStatus(
          missingForeignKey,
          BETTER_AUTH_AUDIT_CHECKS.AUTH_FOREIGN_KEYS_VALIDATED,
        ),
      ).toBe("failed");

      await transaction
        .update(session)
        .set({ userId: `missing-user-${suffix}` })
        .where(eq(session.id, sessionId));
      const orphaned = await runBetterAuthMigrationAudit({
        baseline: null,
        database: auditDatabase,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION,
        trustedIdentityMap: EMPTY_TRUSTED_IDENTITY_MAP,
      });
      expect(
        checkStatus(
          orphaned,
          BETTER_AUTH_AUDIT_CHECKS.AUTH_FOREIGN_KEYS_REACHABLE,
        ),
      ).toBe("failed");

      transaction.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
});

test("census crosses page boundaries with stable database-native ordering", async () => {
  try {
    await database.transaction(async (transaction) => {
      const suffix = Bun.randomUUIDv7();
      await transaction.insert(user).values(
        Array.from({ length: 1001 }, (_, index) => {
          const caseMarker = index % 2 === 0 ? "A" : "a";
          return {
            id: `audit-page-${caseMarker}-${index.toString().padStart(4, "0")}-${suffix}`,
            email: `audit-page-${index}-${suffix}@example.invalid`,
            name: "Audit pagination fixture",
          };
        }),
      );

      const auditDatabase = {
        execute: async (statement: Parameters<typeof transaction.execute>[0]) =>
          await transaction.execute(statement),
      };
      const first = await runBetterAuthMigrationAudit({
        baseline: null,
        database: auditDatabase,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION,
        trustedIdentityMap: EMPTY_TRUSTED_IDENTITY_MAP,
      });
      if (first.status === "error") {
        throw first.error;
      }
      const second = await runBetterAuthMigrationAudit({
        baseline: null,
        database: auditDatabase,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION,
        trustedIdentityMap: EMPTY_TRUSTED_IDENTITY_MAP,
      });
      if (second.status === "error") {
        throw second.error;
      }

      expect(
        BigInt(first.value.baseline.tables["user"]?.rowCount ?? "0"),
      ).toBeGreaterThan(1000n);
      expect(second.value.baseline).toEqual(first.value.baseline);
      throw new TransactionRollbackError();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
});

test("post phases require resource links, final constraints, and the exact baseline row set", async () => {
  try {
    await database.transaction(async (transaction) => {
      // The shared schema is the final 1.7 shape. Recreate the additive bridge
      // state inside this rollback-only transaction before exercising each
      // audit phase.
      await transaction.execute(sql`
        ALTER TABLE account ALTER COLUMN issuer DROP NOT NULL
      `);
      await transaction.execute(sql`
        DROP INDEX IF EXISTS account_issuer_account_id_uidx
      `);

      const suffix = Bun.randomUUIDv7();
      const userId = `audit-post-user-${suffix}`;
      const accountRowId = `audit-post-account-${suffix}`;
      const microsoftAccountRowId = `audit-post-microsoft-${suffix}`;
      const microsoftLegacySub = `legacy-microsoft-sub-${suffix}`;
      const microsoftOid = "71c02436-6600-42fd-84d0-417484a177b0";
      const microsoftIssuer =
        "https://login.microsoftonline.com/3a893563-0d4e-4309-9a31-b6e4e9f64479/v2.0";
      const clientId = `audit-post-client-${suffix}`;
      const resourceId = TEST_OAUTH_RESOURCES[0].identifier;
      await transaction.insert(user).values({
        id: userId,
        email: `audit-post-${suffix}@example.invalid`,
        name: "Audit post fixture",
      });
      await transaction.execute(sql`
        INSERT INTO account (id, account_id, provider_id, user_id, updated_at)
        VALUES
          (${accountRowId}, ${userId}, 'credential', ${userId}, now()),
          (${microsoftAccountRowId}, ${microsoftLegacySub}, 'microsoft', ${userId}, now())
      `);
      await transaction.execute(
        sql`UPDATE account SET issuer = 'local:credential' WHERE id = ${accountRowId}`,
      );
      await transaction.insert(oauthClient).values({
        id: `audit-post-client-row-${suffix}`,
        clientId,
        public: true,
        redirectUris: [`https://client-${suffix}.example.invalid/callback`],
        tokenEndpointAuthMethod: "none",
        type: "web",
      });
      await transaction.execute(
        sql`UPDATE oauth_client SET application_type = 'web' WHERE client_id = ${clientId}`,
      );
      await transaction.execute(sql`
        INSERT INTO oauth_resource (id, identifier, name, allowed_scopes)
        VALUES (
          ${`audit-resource-${suffix}`},
          ${resourceId},
          'Audit resource',
          ARRAY['stella:read']::text[]
        )
      `);
      await transaction.execute(sql`
        INSERT INTO oauth_client_resource (id, client_id, resource_id)
        VALUES (${`audit-link-${suffix}`}, ${clientId}, ${resourceId})
      `);

      const auditDatabase = {
        execute: async (statement: Parameters<typeof transaction.execute>[0]) =>
          await transaction.execute(statement),
      };
      const trustedIdentityMap = {
        formatVersion: 1,
        microsoftAccounts: [
          {
            accountId: microsoftOid,
            accountRowId: microsoftAccountRowId,
            issuer: microsoftIssuer,
            legacyAccountId: microsoftLegacySub,
          },
        ],
      } as const;
      const preMigration = await runBetterAuthMigrationAudit({
        baseline: null,
        database: auditDatabase,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION,
        trustedIdentityMap,
      });
      expect(preMigration.status).toBe("ok");
      if (preMigration.status === "error") {
        throw preMigration.error;
      }
      expect(
        preMigration.value.baseline.tables["account"]?.preservedColumns,
      ).not.toContain("issuer");
      expect(
        preMigration.value.baseline.tables["account"]?.preservedColumns,
      ).toContain("account_id");
      await transaction.execute(
        sql`UPDATE oauth_client SET type = 'invalid' WHERE client_id = ${clientId}`,
      );
      const invalidProjectedOAuthPolicy = await runBetterAuthMigrationAudit({
        baseline: null,
        database: auditDatabase,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION,
        trustedIdentityMap,
      });
      expect(
        checkStatus(
          invalidProjectedOAuthPolicy,
          BETTER_AUTH_AUDIT_CHECKS.OAUTH_POLICY_PROJECTED_VALID,
        ),
      ).toBe("failed");
      await transaction.execute(
        sql`UPDATE oauth_client SET type = 'web' WHERE client_id = ${clientId}`,
      );
      await transaction.execute(sql`
        UPDATE account
           SET account_id = ${microsoftOid}, issuer = ${microsoftIssuer}
         WHERE id = ${microsoftAccountRowId}
      `);

      const postBackfill = await runBetterAuthMigrationAudit({
        baseline: preMigration.value.baseline,
        database: auditDatabase,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.POST_BACKFILL,
        trustedIdentityMap: null,
      });
      if (postBackfill.status === "error") {
        throw postBackfill.error;
      }
      expect(postBackfill.status).toBe("ok");
      expect(postBackfill.value.report.status).toBe("passed");

      await transaction.execute(sql`
        UPDATE account
           SET account_id = ${microsoftLegacySub}
         WHERE id = ${microsoftAccountRowId}
      `);
      const wrongMicrosoftIdentity = await runBetterAuthMigrationAudit({
        baseline: preMigration.value.baseline,
        database: auditDatabase,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.POST_BACKFILL,
        trustedIdentityMap: null,
      });
      expect(
        checkStatus(
          wrongMicrosoftIdentity,
          BETTER_AUTH_AUDIT_CHECKS.ACCOUNT_IDENTITIES_MATCH_TRUSTED_PROJECTION,
        ),
      ).toBe("failed");
      expect(
        checkStatus(
          wrongMicrosoftIdentity,
          BETTER_AUTH_AUDIT_CHECKS.AUTH_ROWS_PRESERVED,
        ),
      ).toBe("passed");
      await transaction.execute(sql`
        UPDATE account
           SET account_id = ${microsoftOid}
         WHERE id = ${microsoftAccountRowId}
      `);

      const beforeConstraints = await runBetterAuthMigrationAudit({
        baseline: preMigration.value.baseline,
        database: auditDatabase,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.POST_MIGRATION,
        trustedIdentityMap: null,
      });
      expect(
        checkStatus(
          beforeConstraints,
          BETTER_AUTH_AUDIT_CHECKS.FINAL_ACCOUNT_CONSTRAINTS,
        ),
      ).toBe("failed");

      await transaction.execute(
        sql`ALTER TABLE account ALTER COLUMN issuer SET NOT NULL`,
      );
      await transaction.execute(
        sql`CREATE UNIQUE INDEX account_issuer_account_id_partial_uidx ON account (issuer, account_id) WHERE issuer IS NOT NULL`,
      );
      const partialIdentityIndex = await runBetterAuthMigrationAudit({
        baseline: preMigration.value.baseline,
        database: auditDatabase,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.POST_MIGRATION,
        trustedIdentityMap: null,
      });
      expect(
        checkStatus(
          partialIdentityIndex,
          BETTER_AUTH_AUDIT_CHECKS.FINAL_ACCOUNT_CONSTRAINTS,
        ),
      ).toBe("failed");
      await transaction.execute(
        sql`DROP INDEX account_issuer_account_id_partial_uidx`,
      );
      await transaction.execute(
        sql`CREATE UNIQUE INDEX account_issuer_account_id_uidx ON account (issuer, account_id)`,
      );
      const postMigration = await runBetterAuthMigrationAudit({
        baseline: preMigration.value.baseline,
        database: auditDatabase,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.POST_MIGRATION,
        trustedIdentityMap: null,
      });
      expect(postMigration.status).toBe("ok");
      if (postMigration.status === "error") {
        throw postMigration.error;
      }
      expect(postMigration.value.report.status).toBe("passed");

      await transaction.execute(sql`
        ALTER POLICY auth_member_select ON member
          USING (organization_id IS NOT NULL)
      `);
      const changedScopedPolicy = await runBetterAuthMigrationAudit({
        baseline: preMigration.value.baseline,
        database: auditDatabase,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.POST_BACKFILL,
        trustedIdentityMap: null,
      });
      expect(
        checkStatus(
          changedScopedPolicy,
          BETTER_AUTH_AUDIT_CHECKS.AUTH_ACCESS_BOUNDARIES,
        ),
      ).toBe("failed");
      await transaction.execute(sql`
        ALTER POLICY auth_member_select ON member
          USING (
            organization_id = (
              SELECT current_setting('app.organization_id', true)
            )
          )
      `);

      await transaction.execute(sql`
        ALTER TABLE oauth_client_resource
          DROP CONSTRAINT oauth_client_resource_client_id_oauth_client_client_id_fkey,
          ADD CONSTRAINT oauth_client_resource_resource_duplicate_fk
            FOREIGN KEY (resource_id) REFERENCES oauth_resource(identifier)
      `);
      const wrongResourceForeignKeys = await runBetterAuthMigrationAudit({
        baseline: preMigration.value.baseline,
        database: auditDatabase,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.POST_MIGRATION,
        trustedIdentityMap: null,
      });
      expect(
        checkStatus(
          wrongResourceForeignKeys,
          BETTER_AUTH_AUDIT_CHECKS.POST_MIGRATION_CONSTRAINTS,
        ),
      ).toBe("failed");
      await transaction.execute(sql`
        ALTER TABLE oauth_client_resource
          DROP CONSTRAINT oauth_client_resource_resource_duplicate_fk,
          ADD CONSTRAINT oauth_client_resource_client_id_oauth_client_client_id_fkey
            FOREIGN KEY (client_id) REFERENCES oauth_client(client_id)
            ON DELETE CASCADE
      `);

      await transaction.execute(
        sql`UPDATE "user" SET name = 'Unexpected migration mutation' WHERE id = ${userId}`,
      );
      const changedRow = await runBetterAuthMigrationAudit({
        baseline: preMigration.value.baseline,
        database: auditDatabase,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.POST_BACKFILL,
        trustedIdentityMap: null,
      });
      expect(
        checkStatus(changedRow, BETTER_AUTH_AUDIT_CHECKS.AUTH_ROWS_PRESERVED),
      ).toBe("failed");
      await transaction.execute(
        sql`UPDATE "user" SET name = 'Audit post fixture' WHERE id = ${userId}`,
      );

      await transaction.execute(sql`GRANT SELECT ON oauth_resource TO stella`);
      const widenedAccess = await runBetterAuthMigrationAudit({
        baseline: preMigration.value.baseline,
        database: auditDatabase,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.POST_BACKFILL,
        trustedIdentityMap: null,
      });
      expect(
        checkStatus(
          widenedAccess,
          BETTER_AUTH_AUDIT_CHECKS.AUTH_ACCESS_BOUNDARIES,
        ),
      ).toBe("failed");
      await transaction.execute(
        sql`REVOKE SELECT ON oauth_resource FROM stella`,
      );

      await transaction.execute(
        sql`DELETE FROM oauth_client_resource WHERE client_id = ${clientId}`,
      );
      const missingLink = await runBetterAuthMigrationAudit({
        baseline: preMigration.value.baseline,
        database: auditDatabase,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.POST_BACKFILL,
        trustedIdentityMap: null,
      });
      expect(
        checkStatus(
          missingLink,
          BETTER_AUTH_AUDIT_CHECKS.OAUTH_CLIENT_RESOURCE_LINKS,
        ),
      ).toBe("failed");
      expect(
        checkStatus(
          missingLink,
          BETTER_AUTH_AUDIT_CHECKS.OAUTH_POLICY_MATCHES_TRUSTED_PROJECTION,
        ),
      ).toBe("failed");
      await transaction.execute(sql`
        INSERT INTO oauth_client_resource (id, client_id, resource_id)
        VALUES (${`audit-link-restored-${suffix}`}, ${clientId}, ${resourceId})
      `);

      await transaction.delete(account).where(eq(account.id, accountRowId));
      await transaction.execute(sql`
        INSERT INTO account (
          id, account_id, provider_id, user_id, issuer, created_at, updated_at
        ) VALUES (
          ${`audit-post-account-replaced-${suffix}`},
          ${userId},
          'credential',
          ${userId},
          'local:credential',
          now(),
          now()
        )
      `);
      const replacedRow = await runBetterAuthMigrationAudit({
        baseline: preMigration.value.baseline,
        database: auditDatabase,
        expectedOAuthResources: TEST_OAUTH_RESOURCES,
        mode: BETTER_AUTH_AUDIT_MODES.POST_BACKFILL,
        trustedIdentityMap: null,
      });
      expect(
        checkStatus(replacedRow, BETTER_AUTH_AUDIT_CHECKS.AUTH_ROWS_PRESERVED),
      ).toBe("failed");

      transaction.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
});
