import { eq, gt } from "drizzle-orm";

import { desktopEditSessions } from "@/api/db/schema";

/** Active locks are open sessions whose liveness TTL has not lapsed. */
export const liveDesktopEditSessionPredicates = (now: Date) => [
  eq(desktopEditSessions.status, "open"),
  gt(desktopEditSessions.tokenExpiresAt, now),
];
