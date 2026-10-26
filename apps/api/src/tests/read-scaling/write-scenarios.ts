import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import { vatRates } from "@/api/db/schema";
import applyVatRatePreset from "@/api/handlers/vat-rates/presets/create";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { HttpStatusResponse } from "@/api/http/status";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScalingTempTables } from "@/api/tests/read-scaling/entity-fixture";

// The audit recorder is stubbed: the measured statements are the write's own,
// which are the ones that could grow with the data its scope already holds.
const noopAuditRecorder: AuditRecorder = async () => {
  await Promise.resolve();
};

const TIME_BILLING_FEATURE =
  "time-billing" satisfies keyof typeof FEATURE_REGISTRY;

/** The actor is enrolled in time and billing, which owns the VAT rate routes. */
const timeBillingAccess = (organizationId: string, userId: string) =>
  createFeatureAccessSnapshot({
    organizationId,
    userId,
    decisions: new Map([
      [
        TIME_BILLING_FEATURE,
        decideFeatureAccess({
          registry: FEATURE_REGISTRY,
          featureId: TIME_BILLING_FEATURE,
          grants: {},
          organizationId,
          userId,
          user: { email: `${userId}@example.test`, emailVerified: true },
          membership: true,
          enrolments: [
            { featureId: TIME_BILLING_FEATURE, organizationId, userId },
          ],
        }),
      ],
    ]),
  });

/**
 * An organization whose VAT rate table already holds `size` periods under
 * codes no preset uses, so applying a preset reads past all of them.
 */
const seedVatRateWriteScaling = async (db: GatedTestDb, size: number) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  await db.insert(organization).values({
    id: organizationId,
    name: "Write fixture",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(user).values({
    id: userId,
    name: "Write actor",
    email: `${userId}@example.test`,
  });
  await db.insert(vatRates).values(
    Array.from({ length: size }, (_, index) => ({
      organizationId,
      code: `existing-${String(index)}`,
      name: `Existing rate ${String(index)}`,
      rateBps: 1000,
      validFrom: "2020-01-01",
    })),
  );
  const safeDb: SafeDb = async (work) =>
    await Result.tryPromise(async () => await db.transaction(work));
  return {
    organizationId,
    userId,
    safeDb,
    cleanup: async () => {
      await db
        .delete(vatRates)
        .where(eq(vatRates.organizationId, organizationId));
      await db.delete(organization).where(eq(organization.id, organizationId));
      await db.delete(user).where(eq(user.id, userId));
    },
  };
};

type WriteFixture = Awaited<ReturnType<typeof seedVatRateWriteScaling>>;

/** The same endpoint definitions are mounted by the API and exercised by the harness. */
export const writeScalingScenarios = [
  {
    name: "VAT rate preset",
    definition: applyVatRatePreset,
    prepare: async (db: GatedTestDb) =>
      await createScalingTempTables(db, [organization, user, vatRates]),
    seed: seedVatRateWriteScaling,
    measure: async (fixture: WriteFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await applyVatRatePreset.handler(
          asTestRaw<Parameters<typeof applyVatRatePreset.handler>[0]>({
            body: { country: "CZ" },
            user: { id: fixture.userId },
            session: { activeOrganizationId: fixture.organizationId },
            memberRole: sessionMemberRole("owner"),
            featureAccessSnapshot: timeBillingAccess(
              fixture.organizationId,
              fixture.userId,
            ),
            safeDb: fixture.safeDb,
            recordAuditEvent: noopAuditRecorder,
            request: new Request(
              "https://example.test/v1/vat-rates/apply-preset",
              { method: "POST" },
            ),
            route: "/v1/vat-rates/apply-preset" satisfies ApiRoutePath,
          }),
        );
        if (response instanceof HttpStatusResponse) {
          panic(
            "VAT rate preset scaling requires a successful handler response",
          );
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
        };
      }),
  },
];
