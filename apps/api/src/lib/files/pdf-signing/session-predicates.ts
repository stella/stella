import { eq, gt } from "drizzle-orm";

import { pdfSigningSessions } from "@/api/db/schema";

/** Active signing exchanges are open sessions whose token TTL has not lapsed. */
export const livePdfSigningSessionPredicates = (now: Date) => [
  eq(pdfSigningSessions.status, "open"),
  // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- cutoff read from the caller's clock, never round-tripped through the database
  gt(pdfSigningSessions.tokenExpiresAt, now),
];
