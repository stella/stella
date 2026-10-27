import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, getTableName, sql, TransactionRollbackError } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
  organizationSettings,
  usageSeatAssignments,
} from "@/api/db/schema";
import { env } from "@/api/env";
import {
  loadOrgAIConfig,
  loadOrgAISettings,
  loadOrgSettingsForAuth,
} from "@/api/lib/ai-config-loader";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { withAggregateSavepoint } from "@/api/lib/db/aggregate-lock";
import { getPgErrorCode } from "@/api/lib/pg-error";
import { getTanStackTextModelInfoForTask } from "@/api/lib/tanstack-ai-models";
import { MANAGED_MODEL_TIER } from "@/api/lib/usage/managed-model-tier";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { createTestState } from "@/api/tests/helpers/test-state";

const testState = createTestState({ file: import.meta.path, config: env });
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("provider settings read recovery (postgres)", () => {
  test.each([false, true])(
    "a denied settings SELECT preserves membership and access queries (access state %s)",
    async (accessStateEnabled) => {
      testState.patchConfig({
        AI_PROVIDER: "openrouter",
        OPENROUTER_API_KEY: "test-instance-key",
        REQUIRE_PERSONAL_AI_KEY: false,
        FEATURE_ORG_ACCESS_STATE: accessStateEnabled,
        FEATURE_CONFIGURED_ACCESS: false,
        FEATURE_FREE_TIER: false,
      });
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const rolledBack = await Result.tryPromise({
          try: async () =>
            await db.transaction(async (tx) => {
              const organizationId = mintAuthProviderId<"organization">();
              const userId = mintAuthProviderId<"user">();
              const reader = { organizationId, userId };
              const roleName = `ai_settings_reader_${Bun.randomUUIDv7().replaceAll("-", "")}`;
              const role = sql.identifier(roleName);
              const fixtureSchema = sql.identifier(
                `ai_settings_${Bun.randomUUIDv7().replaceAll("-", "")}`,
              );
              await tx.insert(user).values({
                id: userId,
                email: `${userId}@example.test`,
                name: "Fixture member",
              });
              await tx.insert(organization).values({
                id: organizationId,
                name: "Fixture organization",
                slug: organizationId,
                createdAt: new Date(),
              });
              await tx.insert(member).values({
                id: mintAuthProviderIdValue(),
                organizationId,
                userId,
                role: "member",
                createdAt: new Date(),
              });
              await tx.insert(organizationAccessStates).values({
                organizationId,
                state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
                evaluationStartedAt: new Date(Date.now() - 60_000),
                evaluationEndsAt: new Date(Date.now() + 60_000),
              });
              // Derive table shapes from the migrated schema. Isolating their
              // grants exercises SQL permission failures without altering public RLS.
              await tx.execute(sql`CREATE SCHEMA ${fixtureSchema}`);
              for (const table of [
                member,
                organizationSettings,
                organizationAccessStates,
                usageSeatAssignments,
              ]) {
                const name = sql.identifier(getTableName(table));
                await tx.execute(
                  sql`CREATE TABLE ${fixtureSchema}.${name} (LIKE public.${name} INCLUDING ALL)`,
                );
              }
              await tx.execute(
                sql`INSERT INTO ${fixtureSchema}.member SELECT * FROM public.member WHERE organization_id = ${organizationId}`,
              );
              await tx.execute(
                sql`INSERT INTO ${fixtureSchema}.organization_access_states SELECT * FROM public.organization_access_states WHERE organization_id = ${organizationId}`,
              );
              await tx.execute(sql`CREATE ROLE ${role} NOLOGIN`);
              await tx.execute(
                sql`GRANT ${role} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`,
              );
              await tx.execute(
                sql`GRANT USAGE ON SCHEMA public, ${fixtureSchema} TO ${role}`,
              );
              await tx.execute(
                sql`GRANT SELECT ON ${fixtureSchema}.member, ${fixtureSchema}.organization_access_states, ${fixtureSchema}.usage_seat_assignments TO ${role}`,
              );
              await tx.execute(
                sql`GRANT SELECT ON public.member, public.organization_access_states, public.usage_seat_assignments, public.usage_entitlements, public.usage_policies TO ${role}`,
              );
              await tx.execute(
                sql`GRANT EXECUTE ON FUNCTION public.organization_effective_policy(text) TO ${role}`,
              );
              await tx.execute(
                sql`SET LOCAL search_path = ${fixtureSchema}, public`,
              );
              await tx.execute(sql`SET LOCAL ROLE ${role}`);
              expect(
                (
                  await tx.execute<{ allowed: boolean }>(
                    sql`SELECT has_table_privilege(current_user, 'organization_settings', 'SELECT') AS allowed`,
                  )
                ).at(0)?.allowed,
              ).toBe(false);

              const refused = await Result.tryPromise({
                try: async () =>
                  await withAggregateSavepoint(
                    tx,
                    async (savepoint) =>
                      await savepoint
                        .select()
                        .from(organizationSettings)
                        .limit(1),
                  ),
                catch: (cause) => cause,
              });
              expect(Result.isError(refused)).toBe(true);
              if (Result.isError(refused)) {
                expect(getPgErrorCode(refused.error)).toBe("42501");
              }

              const providerConfig = (
                await loadOrgAIConfig(tx, reader)
              ).unwrap();
              expect(providerConfig).toBeNull();
              expect(
                getTanStackTextModelInfoForTask("chat", providerConfig, {
                  dataClass: "customer",
                  organizationId,
                  modelTier: MANAGED_MODEL_TIER.standard,
                }),
              ).toMatchObject({
                provider: "openrouter",
                keySource: "instance",
              });
              expect((await loadOrgAISettings(tx, reader)).unwrap()).toEqual({
                orgAIConfig: null,
                promptCachingEnabled: true,
                managedAIResidency: "eu",
              });
              expect(await loadOrgSettingsForAuth(tx, reader)).toEqual({
                orgAIConfig: null,
                orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
                promptCachingEnabled: true,
                managedAIResidency: "eu",
              });
              // Each loader has already run a real member read after the denied
              // SELECT; this also proves the enclosing transaction remains usable.
              expect(
                await tx
                  .select({ id: member.id })
                  .from(member)
                  .where(eq(member.organizationId, organizationId)),
              ).toHaveLength(1);
              expect(
                (
                  await loadOrgSettingsForAuth(tx, {
                    organizationId,
                    userId: mintAuthProviderId<"user">(),
                  })
                ).orgAIConfigStatus,
              ).toBe(ORG_AI_CONFIG_STATUS.memberAssignmentRequired);
              tx.rollback();
            }),
          catch: (cause) => cause,
        });
        expect(Result.isError(rolledBack)).toBe(true);
        if (Result.isError(rolledBack)) {
          expect(rolledBack.error).toBeInstanceOf(TransactionRollbackError);
        }
      });
    },
  );
});
