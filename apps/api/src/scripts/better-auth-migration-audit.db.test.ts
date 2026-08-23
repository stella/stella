import { afterAll, beforeAll, expect, test } from "bun:test";
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
      await transaction.insert(user).values({
        id: userId,
        email: `audit-${suffix}@example.invalid`,
        name: "Audit fixture",
      });
      await transaction.insert(account).values({
        id: accountId,
        accountId: userId,
        providerId: "credential",
        userId,
      });
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
        mode: BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION,
      });
      if (first.status === "error") {
        throw first.error;
      }
      expect(first.status).toBe("ok");
      expect(first.value.report.status).toBe("passed");

      const second = await runBetterAuthMigrationAudit({
        baseline: null,
        database: auditDatabase,
        mode: BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION,
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
        mode: BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION,
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
        mode: BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION,
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
        mode: BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION,
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

test("post phases require resource links, final constraints, and the exact baseline row set", async () => {
  try {
    await database.transaction(async (transaction) => {
      await transaction.execute(
        sql`ALTER TABLE account ADD COLUMN issuer text`,
      );
      await transaction.execute(
        sql`ALTER TABLE oauth_access_token ADD COLUMN resources text[]`,
      );
      await transaction.execute(sql`
        ALTER TABLE oauth_access_token
          ADD COLUMN authorization_code_id text,
          ADD COLUMN requested_user_info_claims text[],
          ADD COLUMN revoked timestamptz,
          ADD COLUMN confirmation jsonb
      `);
      await transaction.execute(
        sql`ALTER TABLE oauth_refresh_token ADD COLUMN resources text[]`,
      );
      await transaction.execute(sql`
        ALTER TABLE oauth_refresh_token
          ADD COLUMN authorization_code_id text,
          ADD COLUMN requested_user_info_claims text[],
          ADD COLUMN rotated_at timestamptz,
          ADD COLUMN rotation_replay_response text,
          ADD COLUMN rotation_replay_expires_at timestamptz,
          ADD COLUMN confirmation jsonb
      `);
      await transaction.execute(
        sql`ALTER TABLE oauth_consent ADD COLUMN resources text[]`,
      );
      await transaction.execute(sql`
        ALTER TABLE oauth_consent
          ADD COLUMN requested_user_info_claims text[]
      `);
      await transaction.execute(sql`
        ALTER TABLE oauth_client
          ADD COLUMN client_discovery_id text,
          ADD COLUMN client_credentials_scopes text[] NOT NULL DEFAULT '{}',
          ADD COLUMN backchannel_logout_uri text,
          ADD COLUMN backchannel_logout_session_required boolean,
          ADD COLUMN application_type text,
          ADD COLUMN jwks text,
          ADD COLUMN jwks_uri text,
          ADD COLUMN dpop_bound_access_tokens boolean
      `);
      await transaction.execute(sql`
        CREATE TABLE oauth_resource (
          id text PRIMARY KEY,
          identifier text NOT NULL UNIQUE,
          name text NOT NULL,
          access_token_ttl integer,
          refresh_token_ttl integer,
          signing_algorithm text,
          signing_key_id text,
          allowed_scopes text[],
          custom_claims jsonb,
          dpop_bound_access_tokens_required boolean,
          disabled boolean,
          created_at timestamptz,
          updated_at timestamptz,
          policy_version integer,
          metadata jsonb
        )
      `);
      await transaction.execute(sql`
        CREATE TABLE oauth_client_resource (
          id text PRIMARY KEY,
          client_id text NOT NULL,
          resource_id text NOT NULL,
          metadata jsonb,
          created_at timestamptz,
          UNIQUE (client_id, resource_id),
          CONSTRAINT oauth_client_resource_client_fk
            FOREIGN KEY (client_id) REFERENCES oauth_client(client_id),
          CONSTRAINT oauth_client_resource_resource_fk
            FOREIGN KEY (resource_id) REFERENCES oauth_resource(identifier)
        )
      `);
      await transaction.execute(sql`
        CREATE TABLE oauth_client_assertion (
          id text PRIMARY KEY,
          expires_at timestamptz NOT NULL
        )
      `);
      for (const tableName of [
        "oauth_resource",
        "oauth_client_resource",
        "oauth_client_assertion",
      ]) {
        // eslint-disable-next-line no-await-in-loop -- transactional DDL must stay ordered on one connection
        await transaction.execute(
          sql`ALTER TABLE ${sql.identifier(tableName)} ENABLE ROW LEVEL SECURITY`,
        );
        // eslint-disable-next-line no-await-in-loop -- policy creation follows RLS enablement
        await transaction.execute(
          sql`CREATE POLICY auth_no_stella_access ON ${sql.identifier(tableName)} FOR ALL TO stella USING (false) WITH CHECK (false)`,
        );
        // eslint-disable-next-line no-await-in-loop -- privilege revocation follows policy creation
        await transaction.execute(
          sql`REVOKE ALL PRIVILEGES ON TABLE ${sql.identifier(tableName)} FROM stella`,
        );
      }

      const suffix = Bun.randomUUIDv7();
      const userId = `audit-post-user-${suffix}`;
      const accountRowId = `audit-post-account-${suffix}`;
      const clientId = `audit-post-client-${suffix}`;
      const resourceId = `https://audit-${suffix}.example.invalid`;
      await transaction.insert(user).values({
        id: userId,
        email: `audit-post-${suffix}@example.invalid`,
        name: "Audit post fixture",
      });
      await transaction.insert(account).values({
        id: accountRowId,
        accountId: userId,
        providerId: "credential",
        userId,
      });
      await transaction.execute(
        sql`UPDATE account SET issuer = 'local:credential' WHERE id = ${accountRowId}`,
      );
      await transaction.insert(oauthClient).values({
        id: `audit-post-client-row-${suffix}`,
        clientId,
        redirectUris: [`https://client-${suffix}.example.invalid/callback`],
        tokenEndpointAuthMethod: "none",
      });
      await transaction.execute(
        sql`UPDATE oauth_client SET application_type = 'web' WHERE client_id = ${clientId}`,
      );
      await transaction.execute(sql`
        INSERT INTO oauth_resource (id, identifier, name)
        VALUES (${`audit-resource-${suffix}`}, ${resourceId}, 'Audit resource')
      `);
      await transaction.execute(sql`
        INSERT INTO oauth_client_resource (id, client_id, resource_id)
        VALUES (${`audit-link-${suffix}`}, ${clientId}, ${resourceId})
      `);

      const auditDatabase = {
        execute: async (statement: Parameters<typeof transaction.execute>[0]) =>
          await transaction.execute(statement),
      };
      const preMigration = await runBetterAuthMigrationAudit({
        baseline: null,
        database: auditDatabase,
        mode: BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION,
      });
      expect(preMigration.status).toBe("ok");
      if (preMigration.status === "error") {
        throw preMigration.error;
      }
      expect(
        preMigration.value.baseline.tables["account"]?.preservedColumns,
      ).not.toContain("issuer");

      const postBackfill = await runBetterAuthMigrationAudit({
        baseline: preMigration.value.baseline,
        database: auditDatabase,
        mode: BETTER_AUTH_AUDIT_MODES.POST_BACKFILL,
      });
      if (postBackfill.status === "error") {
        throw postBackfill.error;
      }
      expect(postBackfill.status).toBe("ok");
      expect(postBackfill.value.report.status).toBe("passed");

      const beforeConstraints = await runBetterAuthMigrationAudit({
        baseline: preMigration.value.baseline,
        database: auditDatabase,
        mode: BETTER_AUTH_AUDIT_MODES.POST_MIGRATION,
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
        mode: BETTER_AUTH_AUDIT_MODES.POST_MIGRATION,
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
        mode: BETTER_AUTH_AUDIT_MODES.POST_MIGRATION,
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
        mode: BETTER_AUTH_AUDIT_MODES.POST_BACKFILL,
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
          DROP CONSTRAINT oauth_client_resource_client_fk,
          ADD CONSTRAINT oauth_client_resource_resource_duplicate_fk
            FOREIGN KEY (resource_id) REFERENCES oauth_resource(identifier)
      `);
      const wrongResourceForeignKeys = await runBetterAuthMigrationAudit({
        baseline: preMigration.value.baseline,
        database: auditDatabase,
        mode: BETTER_AUTH_AUDIT_MODES.POST_MIGRATION,
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
          ADD CONSTRAINT oauth_client_resource_client_fk
            FOREIGN KEY (client_id) REFERENCES oauth_client(client_id)
      `);

      await transaction.execute(
        sql`UPDATE "user" SET name = 'Unexpected migration mutation' WHERE id = ${userId}`,
      );
      const changedRow = await runBetterAuthMigrationAudit({
        baseline: preMigration.value.baseline,
        database: auditDatabase,
        mode: BETTER_AUTH_AUDIT_MODES.POST_BACKFILL,
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
        mode: BETTER_AUTH_AUDIT_MODES.POST_BACKFILL,
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
        mode: BETTER_AUTH_AUDIT_MODES.POST_BACKFILL,
      });
      expect(
        checkStatus(
          missingLink,
          BETTER_AUTH_AUDIT_CHECKS.OAUTH_CLIENT_RESOURCE_LINKS,
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
        mode: BETTER_AUTH_AUDIT_MODES.POST_BACKFILL,
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
