import { and, desc, eq, sql } from "drizzle-orm";

import { DESKTOP_HANDOFF_MIN_SUPPORTED_PROTOCOL } from "@stll/api-contract/desktop-handoff";
import { DESKTOP_PRESENCE_POLICY } from "@stll/api-contract/desktop-presence";
import type {
  DesktopPresence,
  DesktopPresenceReport,
} from "@stll/api-contract/desktop-presence";

import type { ScopedDb } from "@/api/db/safe-db";
import { desktopPresence } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

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
  });

type DesktopObservation = Pick<
  typeof desktopPresence.$inferSelect,
  "version" | "protocol" | "lastSeenAt"
>;

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
