import { rootDb } from "@/api/db/root";
import { createSessionSignInStore } from "@/api/lib/auth/session-sign-ins";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

/** The device fields of a user's other recent sessions, newest first. */
export const findOtherSessionDevices = async (
  userId: SafeId<"user">,
  sessionId: string,
) =>
  await rootDb.query.session.findMany({
    where: {
      userId,
      id: { ne: sessionId },
    },
    orderBy: { createdAt: "desc" },
    limit: LIMITS.newDeviceLoginSessionScanLimit,
    columns: {
      ipAddress: true,
      userAgent: true,
    },
  });

/**
 * The account holder's sign-in details. Session rows are auth data outside
 * row security, so the store binds the owner connection; every query scopes
 * itself to the authenticated user's own sessions.
 */
export const sessionSignInStore = () =>
  createSessionSignInStore({ database: rootDb });
