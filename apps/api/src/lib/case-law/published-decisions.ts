/** Canonical publication policy for public decision reads. */
import type { SQL } from "drizzle-orm";

import { caseLawDecisions } from "@/api/db/schema";

import { publishedCaseLawDecisionFor } from "./published-decisions-sql";

export {
  publishedCaseLawDecisionFor,
  publishedCaseLawDecisionSqlFor,
} from "./published-decisions-sql";

export const publishedCaseLawDecision: SQL =
  publishedCaseLawDecisionFor(caseLawDecisions);
