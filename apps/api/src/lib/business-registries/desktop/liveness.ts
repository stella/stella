import { and, eq } from "drizzle-orm";

import { Temporal } from "@stll/time";

import { apikey } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import { parseDesktopRegistryMetadata } from "@/api/lib/business-registries/desktop/config";
import { desktopRegistryKeyOrganizationScope } from "@/api/lib/business-registries/desktop/scope";

export type DesktopKey = {
  readonly keyId: string;
  readonly userId: SafeId<"user">;
  readonly organizationId: SafeId<"organization">;
  /** The device key the credential is bound to. */
  readonly deviceJkt: string;
};

/** Whether a desktop credential still authorizes what it opened. */
export type DesktopKeyLiveness = (key: DesktopKey) => Promise<boolean>;

/**
 * A credential is live while it is enabled, never expired, inside its
 * inactivity window, and still bound to the same organization and device key.
 * Rotation keeps the key id, so a long-lived connection stays live across it;
 * every revocation path disables the key, so each ends it.
 */
export const desktopKeyLiveness =
  (db: Pick<typeof rootDb, "select"> = rootDb): DesktopKeyLiveness =>
  async (desktopKey: DesktopKey) => {
    const { keyId, userId, organizationId, deviceJkt } = desktopKey;
    const [key] = await db
      .select({ expiresAt: apikey.expiresAt, metadata: apikey.metadata })
      .from(apikey)
      .where(
        and(
          eq(apikey.id, keyId),
          eq(apikey.referenceId, userId),
          eq(apikey.enabled, true),
          desktopRegistryKeyOrganizationScope(organizationId),
        ),
      )
      .limit(1);
    const metadata = parseDesktopRegistryMetadata(key?.metadata);
    return (
      key !== undefined &&
      key.expiresAt === null &&
      metadata.success &&
      metadata.output.deviceJkt === deviceJkt &&
      metadata.output.organizationId === organizationId &&
      Temporal.Instant.from(metadata.output.inactivityExpiresAt)
        .epochMilliseconds > Temporal.Now.instant().epochMilliseconds
    );
  };
