import { and, desc, eq, notInArray, sql } from "drizzle-orm";

import { DESKTOP_HANDOFF_MIN_SUPPORTED_PROTOCOL } from "@stll/api-contract/desktop-handoff";
import { DESKTOP_PRESENCE_POLICY } from "@stll/api-contract/desktop-presence";
import type {
  DesktopPresence,
  DesktopPresenceReport,
} from "@stll/api-contract/desktop-presence";

import { member } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import { desktopPresence } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

export const DESKTOP_PRESENCE_INSTALLATION_LIMIT = 10;

// Heartbeats overwrite this technical observation; they create no history or audit rows.
type ReportDesktopPresenceOptions = {
  scopedDb: ScopedDb;
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  report: DesktopPresenceReport;
};

export const reportDesktopPresence = async ({
  scopedDb,
  userId,
  organizationId,
  report,
}: ReportDesktopPresenceOptions) =>
  await scopedDb(async (tx) => {
    // Membership precedes presence locks, matching member and account removal.
    // It also serializes all installation writes for this owner.
    const memberships = await tx
      .select({ id: member.id })
      .from(member)
      .where(
        and(
          eq(member.userId, userId),
          eq(member.organizationId, organizationId),
        ),
      )
      .limit(1)
      .for("update");
    if (memberships.length === 0) {
      return false;
    }
    // audit: skip - reportDesktopPresence overwrites owner-scoped technical presence; heartbeat history is not retained
    await tx
      .insert(desktopPresence)
      .values({
        userId,
        organizationId,
        desktopId: report.desktopId,
        version: report.version,
        protocol: report.protocol,
        lastSeenAt: sql`clock_timestamp()`,
      })
      .onConflictDoUpdate({
        target: [
          desktopPresence.userId,
          desktopPresence.organizationId,
          desktopPresence.desktopId,
        ],
        set: {
          version: report.version,
          protocol: report.protocol,
          lastSeenAt: sql`clock_timestamp()`,
        },
      });
    // Keep a disconnected observation until membership removal; expiry alone
    // must not turn a previously reported desktop into never-reported.
    // audit: skip - discard superseded owner-scoped technical observations
    await tx.delete(desktopPresence).where(
      and(
        eq(desktopPresence.userId, userId),
        eq(desktopPresence.organizationId, organizationId),
        notInArray(
          desktopPresence.desktopId,
          tx
            .select({ desktopId: desktopPresence.desktopId })
            .from(desktopPresence)
            .where(
              and(
                eq(desktopPresence.userId, userId),
                eq(desktopPresence.organizationId, organizationId),
              ),
            )
            .orderBy(
              desc(desktopPresence.lastSeenAt),
              desktopPresence.desktopId,
            )
            .limit(DESKTOP_PRESENCE_INSTALLATION_LIMIT),
        ),
      ),
    );
    return true;
  });

type DesktopPresenceRow = typeof desktopPresence.$inferSelect;
type DesktopProjection = Extract<
  DesktopPresence,
  { desktop: unknown }
>["desktop"];

const UNPROJECTED_DESKTOP_PRESENCE_COLUMNS = [
  // Ownership scopes the query and is never part of the presence response.
  "userId",
  "organizationId",
  // Installation identity selects the observation, but is not exposed to the browser.
  "desktopId",
] as const satisfies readonly (keyof DesktopPresenceRow)[];

type MissingDesktopPresenceColumn = UnprojectedColumns<
  DesktopPresenceRow,
  DesktopProjection,
  (typeof UNPROJECTED_DESKTOP_PRESENCE_COLUMNS)[number]
>;
type UnexpectedDesktopPresenceColumn = UnbackedProjectionKeys<
  DesktopPresenceRow,
  DesktopProjection,
  (typeof UNPROJECTED_DESKTOP_PRESENCE_COLUMNS)[number]
>;

true satisfies MissingDesktopPresenceColumn extends never ? true : never;
true satisfies UnexpectedDesktopPresenceColumn extends never ? true : never;

type DesktopObservation = Pick<DesktopPresenceRow, keyof DesktopProjection>;

export const classifyDesktopPresence = (
  row: DesktopObservation | undefined,
  now: Date,
): DesktopPresence => {
  if (!row) {
    return { type: "none" };
  }
  const desktop = {
    version: row.version,
    protocol: row.protocol,
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
  if (
    now.getTime() - row.lastSeenAt.getTime() >
    DESKTOP_PRESENCE_POLICY.freshnessSeconds * 1000
  ) {
    return { type: "not_connected", desktop };
  }
  if (row.protocol < DESKTOP_HANDOFF_MIN_SUPPORTED_PROTOCOL) {
    return { type: "outdated", desktop };
  }
  return { type: "current", desktop };
};

type ReadDesktopPresenceOptions = {
  scopedDb: ScopedDb;
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  now?: Date;
};

export const readDesktopPresence = async ({
  scopedDb,
  userId,
  organizationId,
  now = new Date(),
}: ReadDesktopPresenceOptions) => {
  const cutoff = new Date(
    now.getTime() - DESKTOP_PRESENCE_POLICY.freshnessSeconds * 1000,
  );
  const rows = await scopedDb((tx) =>
    tx
      .select({
        version: desktopPresence.version,
        protocol: desktopPresence.protocol,
        lastSeenAt: desktopPresence.lastSeenAt,
      })
      .from(desktopPresence)
      .where(
        and(
          eq(desktopPresence.userId, userId),
          eq(desktopPresence.organizationId, organizationId),
        ),
      )
      .orderBy(
        // A running supported installation takes precedence over a newer old installation.
        desc(
          sql`${desktopPresence.lastSeenAt} >= ${cutoff}::timestamptz AND ${desktopPresence.protocol} >= ${DESKTOP_HANDOFF_MIN_SUPPORTED_PROTOCOL}`,
        ),
        desc(desktopPresence.lastSeenAt),
        desktopPresence.desktopId,
      )
      .limit(1),
  );
  return classifyDesktopPresence(rows.at(0), now);
};
