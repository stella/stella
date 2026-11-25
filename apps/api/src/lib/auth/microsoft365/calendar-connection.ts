import { Result } from "better-result";

import type { SafeDb } from "@/api/db/safe-db-types";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

import { capabilityEnabled, grantedCapabilities } from "./capabilities";

type CalendarConnectionContext = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

const TURNED_OFF = { type: "turnedOff" } as const;

/**
 * Whether the member's Microsoft 365 calendar can be read, and why not:
 * `turnedOff` (deployment or organization policy), `notConnected` (no
 * connection), `needsReconnect` (the connection must be renewed or lacks
 * calendar consent). Every caller runs it right before an outbound read, so
 * a policy change or revocation since an earlier check stops the read.
 */
export const readCalendarConnection = async (
  { safeDb, organizationId, userId }: CalendarConnectionContext,
  deploymentEnabled = isDeploymentFeatureEnabled,
) => {
  if (!deploymentEnabled("FEATURE_SHAREPOINT")) {
    return Result.ok(TURNED_OFF);
  }
  return await safeDb(async (tx) => {
    const policy = await tx.query.organizationSettings.findFirst({
      where: { organizationId: { eq: organizationId } },
      columns: {
        sharepointConnectionEnabled: true,
        microsoft365CalendarReadEnabled: true,
      },
    });
    if (!capabilityEnabled(policy, "calendar.read")) {
      return TURNED_OFF;
    }
    const connection = await tx.query.sharepointConnections.findFirst({
      where: { organizationId: { eq: organizationId }, userId: { eq: userId } },
    });
    if (!connection) {
      return { type: "notConnected" } as const;
    }
    if (
      connection.status !== "connected" ||
      !grantedCapabilities(connection.scope).includes("calendar.read")
    ) {
      return { type: "needsReconnect" } as const;
    }
    return {
      type: "connected",
      connection: {
        ...connection,
        userId: brandPersistedUserId(connection.userId),
      },
    } as const;
  });
};
