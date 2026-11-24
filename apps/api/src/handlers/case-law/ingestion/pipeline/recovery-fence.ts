import { sql } from "drizzle-orm";

import { caseLawDecisions } from "@/api/db/schema";

/** Covers canonical payload repairs as well as fresh publisher observations. */
export const decisionRecoveryRowFingerprint = () =>
  sql<string>`encode(sha256(convert_to(to_jsonb(${caseLawDecisions})::text, 'UTF8')), 'hex')`;
