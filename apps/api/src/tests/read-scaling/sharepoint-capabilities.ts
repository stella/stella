import { panic, Result } from "better-result";
import { eq, getTableName, sql } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { organizationSettings, sharepointConnections } from "@/api/db/schema";
import { env } from "@/api/env";
import setSharepointCapabilities from "@/api/handlers/sharepoint/set-capabilities";
import { HttpStatusResponse } from "@/api/http/status";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { createScalingTempTables } from "./entity-fixture";

const seedCapabilityWrite = async (db: GatedTestDb, size: number) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  await db.insert(organizationSettings).values({
    id: createSafeId<"organizationSettings">(),
    organizationId,
  });
  await db.insert(sharepointConnections).values(
    Array.from({ length: size }, () => ({
      id: createSafeId<"sharepointConnection">(),
      organizationId,
      userId: mintAuthProviderId<"user">(),
      accessTokenEncrypted: Buffer.alloc(32),
      accessTokenIv: Buffer.alloc(12),
      status: "connected" as const,
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
        .delete(sharepointConnections)
        .where(eq(sharepointConnections.organizationId, organizationId));
      await db
        .delete(organizationSettings)
        .where(eq(organizationSettings.organizationId, organizationId));
    },
  };
};

type CapabilityWriteFixture = Awaited<ReturnType<typeof seedCapabilityWrite>>;
const recordAuditEvent: AuditRecorder = async () => {
  await Promise.resolve();
};

export const sharepointCapabilitiesScalingScenario = {
  name: "delegated capability policy",
  definition: setSharepointCapabilities,
  prepare: async (db: GatedTestDb) => {
    const tables = [organizationSettings, sharepointConnections];
    await createScalingTempTables(db, tables);
    // Aggregate row locks name public relations; this fixture owns a disposable cluster.
    for (const table of tables) {
      const name = sql.identifier(getTableName(table));
      await db.execute(
        sql`CREATE TABLE public.${name} (LIKE pg_temp.${name} INCLUDING DEFAULTS)`,
      );
      await db.execute(sql`DROP TABLE pg_temp.${name}`);
    }
    await db.execute(
      "CREATE UNIQUE INDEX ON public.organization_settings (organization_id)",
    );
  },
  seed: seedCapabilityWrite,
  measure: async (fixture: CapabilityWriteFixture) => {
    const previous = env.FEATURE_SHAREPOINT;
    env.FEATURE_SHAREPOINT = true;
    try {
      return await runWithMeasuredQueryCounter(async (counter) => {
        const response = await setSharepointCapabilities.handler(
          asTestRaw<Parameters<typeof setSharepointCapabilities.handler>[0]>({
            body: { capabilities: ["calendar.read"] },
            session: { activeOrganizationId: fixture.organizationId },
            user: { id: fixture.userId },
            memberRole: sessionMemberRole("owner"),
            safeDb: fixture.safeDb,
            recordAuditEvent,
            request: new Request(
              "https://example.test/v1/sharepoint/capabilities",
              { method: "PUT" },
            ),
            route: "/v1/sharepoint/capabilities",
          }),
        );
        if (response instanceof HttpStatusResponse) {
          panic("Capability scaling requires a successful policy update");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
        };
      });
    } finally {
      env.FEATURE_SHAREPOINT = previous;
    }
  },
};
