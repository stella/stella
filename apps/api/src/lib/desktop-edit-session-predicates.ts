import { eq, gt, lt } from "drizzle-orm";

import { desktopEditSessions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

/** Active locks are open sessions whose liveness TTL has not lapsed. */
export const liveDesktopEditSessionPredicates = (now: Date) => [
  eq(desktopEditSessions.status, "open"),
  // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- cutoff read from the caller's clock, never round-tripped through the database
  gt(desktopEditSessions.tokenExpiresAt, now),
];

export const expiredOpenDesktopEditSessionPredicates = (now: Date) => [
  eq(desktopEditSessions.status, "open"),
  // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- cutoff read from the caller's clock, never round-tripped through the database
  lt(desktopEditSessions.tokenExpiresAt, now),
];

type OwnDesktopEditSessionTargetPredicateInput = {
  entityId: SafeId<"entity">;
  propertyId: SafeId<"property">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

const ownDesktopEditSessionTargetPredicates = ({
  entityId,
  propertyId,
  userId,
  workspaceId,
}: OwnDesktopEditSessionTargetPredicateInput) => [
  eq(desktopEditSessions.createdBy, userId),
  eq(desktopEditSessions.entityId, entityId),
  eq(desktopEditSessions.propertyId, propertyId),
  eq(desktopEditSessions.workspaceId, workspaceId),
];

type TimedOwnDesktopEditSessionTargetPredicateInput =
  OwnDesktopEditSessionTargetPredicateInput & {
    now: Date;
  };

export const liveOwnDesktopEditSessionTargetPredicates = ({
  now,
  ...target
}: TimedOwnDesktopEditSessionTargetPredicateInput) => [
  ...ownDesktopEditSessionTargetPredicates(target),
  ...liveDesktopEditSessionPredicates(now),
];

export const expiredOwnDesktopEditSessionTargetPredicates = ({
  now,
  ...target
}: TimedOwnDesktopEditSessionTargetPredicateInput) => [
  ...ownDesktopEditSessionTargetPredicates(target),
  ...expiredOpenDesktopEditSessionPredicates(now),
];
