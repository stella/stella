import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";
import { RUNTIME_MODE } from "@stll/runtime-mode";

import { SETTING_ORGANIZATION_ID, SETTING_USER_ID } from "@/api/db/rls";
import { safeDbFromScoped } from "@/api/db/safe-db";
import type { ScopedDb } from "@/api/db/safe-db";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import enrolFeature from "@/api/handlers/organization-settings/feature-enrolments/enrol";
import getFeatureEnrolments from "@/api/handlers/organization-settings/feature-enrolments/get";
import unenrolFeature from "@/api/handlers/organization-settings/feature-enrolments/unenrol";
import type { AuditEvent } from "@/api/lib/audit-log";
import { resolveFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!runPostgresTests)(
  "feature enrolment ownership (postgres)",
  () => {
    test("enrolments converge and every read and mutation isolates both the user and organization", async () => {
      if (!databaseUrl) {
        panic("DATABASE_URL required");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { sql: client, db } = openClient();
        const scopedDatabase = markRlsDatabase(db);
        const previousFlag = env.FEATURE_TIME_BILLING;
        env.FEATURE_TIME_BILLING = true;
        const restoreRuntimeMode = setRuntimeModeForTesting({
          mode: RUNTIME_MODE.strict,
        });
        const orgA = mintAuthProviderId<"organization">();
        const orgB = mintAuthProviderId<"organization">();
        const userA = mintAuthProviderId<"user">();
        const userB = mintAuthProviderId<"user">();
        try {
          for (const orgId of [orgA, orgB]) {
            await client`INSERT INTO organization (id, name, slug, created_at) VALUES (${orgId}, 'Enrolment organization', ${orgId}, now())`;
          }
          for (const userId of [userA, userB]) {
            await client`INSERT INTO "user" (id, name, email, email_verified) VALUES (${userId}, 'Enrolment user', ${`${userId}@example.test`}, true)`;
          }
          for (const orgId of [orgA, orgB]) {
            for (const userId of [userA, userB]) {
              await client`INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (${Bun.randomUUIDv7()}, ${orgId}, ${userId}, 'member', now())`;
            }
          }
          const auditEvents: AuditEvent[] = [];
          const callerContext = {
            safeDb: safeDbFromScoped(
              asTestRaw<ScopedDb>(
                createScopedDb(scopedDatabase, [], orgA, userA),
              ),
            ),
            session: { activeOrganizationId: orgA },
            user: { id: userA },
            params: { featureId: "time-billing" },
            recordAuditEvent: auditRecorderDouble((events) => {
              auditEvents.push(...events);
            }),
          };
          for (let attempt = 0; attempt < 2; attempt++) {
            expect(
              await enrolFeature.handler(
                createTestHandlerContext<
                  Parameters<typeof enrolFeature.handler>[0]
                >(callerContext),
              ),
            ).toEqual({ featureId: "time-billing", enrolled: true });
          }
          expect(auditEvents).toHaveLength(1);
          expect(auditEvents.at(0)).toMatchObject({
            metadata: { featureId: "time-billing", enrolled: true },
          });
          for (const userId of [userA, userB]) {
            for (const orgId of [orgA, orgB]) {
              const owns = userId === userA && orgId === orgA;
              const callerDb = createScopedDb(
                scopedDatabase,
                [],
                orgId,
                userId,
              );
              const snapshot = await callerDb(
                async (tx) =>
                  await resolveFeatureAccessSnapshot({
                    tx,
                    organizationId: orgId,
                    userId,
                  }),
              );
              expect(snapshot.decisions.get("time-billing")?.status).toBe(
                owns ? "enabled" : "hidden",
              );
              expect(
                await getFeatureEnrolments.handler(
                  createTestHandlerContext<
                    Parameters<typeof getFeatureEnrolments.handler>[0]
                  >({
                    safeDb: safeDbFromScoped(
                      asTestRaw<ScopedDb>(
                        createScopedDb(scopedDatabase, [], orgId, userId),
                      ),
                    ),
                    session: { activeOrganizationId: orgId },
                    user: { id: userId },
                  }),
                ),
              ).toEqual({
                features: [{ featureId: "time-billing", enrolled: owns }],
              });
              await client.begin(async (tx) => {
                await tx`SELECT set_config('role', 'stella', true), set_config(${SETTING_ORGANIZATION_ID}, ${orgId}, true), set_config(${SETTING_USER_ID}, ${userId}, true)`;
                const visible =
                  await tx`SELECT feature_id FROM feature_enrolments`;
                expect(visible).toEqual(
                  owns ? [{ feature_id: "time-billing" }] : [],
                );
                if (owns) {
                  return;
                }
                const updated =
                  await tx`UPDATE feature_enrolments SET created_at = now() WHERE user_id = ${userA} AND organization_id = ${orgA} RETURNING feature_id`;
                expect(updated).toHaveLength(0);
                const deleted =
                  await tx`DELETE FROM feature_enrolments WHERE user_id = ${userA} AND organization_id = ${orgA} RETURNING feature_id`;
                expect(deleted).toHaveLength(0);
              });
              if (owns) {
                continue;
              }
              expect(
                await rejectionOf(
                  client.begin(async (tx) => {
                    await tx`SELECT set_config('role', 'stella', true), set_config(${SETTING_ORGANIZATION_ID}, ${orgId}, true), set_config(${SETTING_USER_ID}, ${userId}, true)`;
                    await tx`INSERT INTO feature_enrolments (user_id, organization_id, feature_id) VALUES (${userA}, ${orgA}, 'time-billing')`;
                  }),
                ),
              ).toMatchObject({
                message:
                  'new row violates row-level security policy for table "feature_enrolments"',
              });
            }
          }
          for (const changed of ["user", "organization"] as const) {
            expect(
              await rejectionOf(
                client.begin(async (tx) => {
                  await tx`SELECT set_config('role', 'stella', true), set_config(${SETTING_ORGANIZATION_ID}, ${orgA}, true), set_config(${SETTING_USER_ID}, ${userA}, true)`;
                  await tx`UPDATE feature_enrolments SET user_id = ${changed === "user" ? userB : userA}, organization_id = ${changed === "organization" ? orgB : orgA}`;
                }),
              ),
            ).toMatchObject({
              message:
                'new row violates row-level security policy for table "feature_enrolments"',
            });
          }
          for (let attempt = 0; attempt < 2; attempt++) {
            expect(
              await unenrolFeature.handler(
                createTestHandlerContext<
                  Parameters<typeof unenrolFeature.handler>[0]
                >(callerContext),
              ),
            ).toEqual({ featureId: "time-billing", enrolled: false });
          }
          expect(auditEvents).toHaveLength(2);
          expect(auditEvents.at(1)).toMatchObject({
            metadata: { featureId: "time-billing", enrolled: false },
          });
          expect(
            await getFeatureEnrolments.handler(
              createTestHandlerContext<
                Parameters<typeof getFeatureEnrolments.handler>[0]
              >(callerContext),
            ),
          ).toEqual({
            features: [{ featureId: "time-billing", enrolled: false }],
          });
          env.FEATURE_TIME_BILLING = false;
          expect(
            await getFeatureEnrolments.handler(
              createTestHandlerContext<
                Parameters<typeof getFeatureEnrolments.handler>[0]
              >(callerContext),
            ),
          ).toEqual({ features: [] });
          expect(
            await enrolFeature.handler(
              createTestHandlerContext<
                Parameters<typeof enrolFeature.handler>[0]
              >(callerContext),
            ),
          ).toMatchObject({ code: 404 });
          expect(
            await unenrolFeature.handler(
              createTestHandlerContext<
                Parameters<typeof unenrolFeature.handler>[0]
              >(callerContext),
            ),
          ).toMatchObject({ code: 404 });
          expect(auditEvents).toHaveLength(2);
        } finally {
          env.FEATURE_TIME_BILLING = previousFlag;
          restoreRuntimeMode();
          for (const orgId of [orgA, orgB]) {
            await client`DELETE FROM organization WHERE id = ${orgId}`;
          }
          for (const userId of [userA, userB]) {
            await client`DELETE FROM "user" WHERE id = ${userId}`;
          }
        }
      });
    });
  },
);
