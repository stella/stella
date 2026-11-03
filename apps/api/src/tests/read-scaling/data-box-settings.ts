import { panic, Result } from "better-result";
import { eq, inArray } from "drizzle-orm";

import { ORGANIZATION_DATA_BOX_LIMIT } from "@stll/api-contract/data-box";

import type { SafeDb } from "@/api/db/safe-db";
import { organizationSettings } from "@/api/db/schema";
import addDataBox from "@/api/handlers/organization-settings/correspondence/data-boxes/create";
import removeDataBox from "@/api/handlers/organization-settings/correspondence/data-boxes/delete";
import readDataBoxes from "@/api/handlers/organization-settings/correspondence/data-boxes/get";
import { HttpStatusResponse } from "@/api/http/status";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const PEER_BOX_IDS = Array.from(
  { length: ORGANIZATION_DATA_BOX_LIMIT },
  (_, index) => `box${String(index).padStart(4, "0")}`,
);
const recordAuditEvent: AuditRecorder = async () => {
  await Promise.resolve();
};

/** As in the write harness, audit storage is outside this handler's measured queries. */
export const seedDataBoxSettingsScaling = async (
  db: GatedTestDb,
  size: number,
) => {
  const boxIds = Array.from(
    { length: ORGANIZATION_DATA_BOX_LIMIT },
    (_, index) =>
      `b${String(size).padStart(3, "0")}${String(index).padStart(3, "0")}`,
  );
  const rows = Array.from({ length: size }, (_, index) => ({
    id: createSafeId<"organizationSettings">(),
    organizationId: mintAuthProviderId<"organization">(),
    dataBoxIds: index === 0 ? boxIds : PEER_BOX_IDS,
  }));
  await db.insert(organizationSettings).values(rows);
  const target = rows.at(0) ?? panic("Settings scaling needs a target");
  const safeDb: SafeDb = async (work) =>
    await Result.tryPromise(async () => await db.transaction(work));
  return {
    organizationId: target.organizationId,
    userId: mintAuthProviderId<"user">(),
    boxIds,
    safeDb,
    reset: async (currentBoxIds: string[]) => {
      await db
        .update(organizationSettings)
        .set({ dataBoxIds: currentBoxIds })
        .where(eq(organizationSettings.id, target.id));
    },
    cleanup: async () => {
      await db.delete(organizationSettings).where(
        inArray(
          organizationSettings.id,
          rows.map(({ id }) => id),
        ),
      );
    },
  };
};

type DataBoxFixture = Awaited<ReturnType<typeof seedDataBoxSettingsScaling>>;

export const dataBoxSettingsScalingScenarios = [
  {
    name: "organization data-box inventory",
    definition: readDataBoxes,
    measure: async (fixture: DataBoxFixture) => {
      await fixture.reset(fixture.boxIds);
      return await runWithMeasuredQueryCounter(async (counter) => {
        const response = await readDataBoxes.handler(
          asTestRaw<Parameters<typeof readDataBoxes.handler>[0]>({
            session: { activeOrganizationId: fixture.organizationId },
            user: {
              id: fixture.userId,
              email: `${fixture.userId}@example.test`,
              emailVerified: true,
            },
            memberRole: sessionMemberRole("owner"),
            safeDb: fixture.safeDb,
            request: new Request(
              "https://example.test/v1/organization-settings/correspondence/data-boxes",
            ),
            route: "/v1/organization-settings/correspondence/data-boxes",
          }),
        );
        if (
          response instanceof HttpStatusResponse ||
          response.boxIds.join(",") !== fixture.boxIds.join(",")
        ) {
          panic(
            "Settings read must return the target organization's bounded inventory",
          );
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: response.boxIds.length,
        };
      });
    },
  },
  {
    name: "add organization data box",
    definition: addDataBox,
    measure: async (fixture: DataBoxFixture) => {
      const changedBox =
        fixture.boxIds.at(-1) ?? panic("Data-box capacity must be positive");
      await fixture.reset(fixture.boxIds.slice(0, -1));
      return await runWithMeasuredQueryCounter(async (counter) => {
        const response = await addDataBox.handler(
          asTestRaw<Parameters<typeof addDataBox.handler>[0]>({
            session: { activeOrganizationId: fixture.organizationId },
            user: {
              id: fixture.userId,
              email: `${fixture.userId}@example.test`,
              emailVerified: true,
            },
            memberRole: sessionMemberRole("owner"),
            safeDb: fixture.safeDb,
            recordAuditEvent,
            body: { boxId: changedBox },
            request: new Request(
              "https://example.test/v1/organization-settings/correspondence/data-boxes",
              { method: "POST" },
            ),
            route: "/v1/organization-settings/correspondence/data-boxes",
          }),
        );
        if (
          response instanceof HttpStatusResponse ||
          response.boxIds.join(",") !== fixture.boxIds.join(",")
        ) {
          panic("Settings add must fill the final available inventory slot");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: response.boxIds.length,
        };
      });
    },
  },
  {
    name: "remove organization data box",
    definition: removeDataBox,
    measure: async (fixture: DataBoxFixture) => {
      const changedBox =
        fixture.boxIds.at(-1) ?? panic("Data-box capacity must be positive");
      await fixture.reset(fixture.boxIds);
      return await runWithMeasuredQueryCounter(async (counter) => {
        const response = await removeDataBox.handler(
          asTestRaw<Parameters<typeof removeDataBox.handler>[0]>({
            session: { activeOrganizationId: fixture.organizationId },
            user: {
              id: fixture.userId,
              email: `${fixture.userId}@example.test`,
              emailVerified: true,
            },
            memberRole: sessionMemberRole("owner"),
            safeDb: fixture.safeDb,
            recordAuditEvent,
            params: { boxId: changedBox },
            request: new Request(
              `https://example.test/v1/organization-settings/correspondence/data-boxes/${changedBox}`,
              { method: "DELETE" },
            ),
            route: "/v1/organization-settings/correspondence/data-boxes/:boxId",
          }),
        );
        if (
          response instanceof HttpStatusResponse ||
          response.boxIds.join(",") !== fixture.boxIds.slice(0, -1).join(",")
        ) {
          panic(
            "Settings removal must remove only the named ID from the full inventory",
          );
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: response.boxIds.length,
        };
      });
    },
  },
];
