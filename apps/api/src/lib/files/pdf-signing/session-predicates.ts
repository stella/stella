import { eq, lte, not } from "drizzle-orm";

import { pdfSigningSessions } from "@/api/db/schema";

const pdfSigningSessionHasExpired = (now: Date) =>
  // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- cutoff read from the caller's clock, never round-tripped through the database
  lte(pdfSigningSessions.tokenExpiresAt, now);

/** Active signing exchanges are open sessions whose token TTL has not lapsed. */
export const livePdfSigningSessionPredicates = (now: Date) => [
  eq(pdfSigningSessions.status, "open"),
  not(pdfSigningSessionHasExpired(now)),
];

export const expiredOpenPdfSigningSessionPredicates = (now: Date) => [
  eq(pdfSigningSessions.status, "open"),
  pdfSigningSessionHasExpired(now),
];
