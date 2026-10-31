import { rootDb } from "@/api/db/root";
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
