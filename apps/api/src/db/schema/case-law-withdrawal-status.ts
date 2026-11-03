import { sql } from "drizzle-orm";
import * as p from "drizzle-orm/pg-core";

import { timestamptz } from "@/api/db/columns";

import { safeUuid } from "./common";

export const CASE_LAW_WITHDRAWAL_STATUSES = ["withdrawn"] as const;

/** Only the withdrawal state crosses the public reader boundary. */
export const caseLawWithdrawalStatus = p.pgView("case_law_withdrawal_status", {
  decisionId: safeUuid<"caseLawDecision">("decision_id").notNull(),
  status: p.text("status", { enum: CASE_LAW_WITHDRAWAL_STATUSES }).notNull(),
  withdrawnAt: timestamptz("withdrawn_at").notNull(),
}).as(sql`SELECT id AS decision_id, 'withdrawn'::text AS status,
  redacted_at AS withdrawn_at FROM case_law_decisions
  WHERE redacted_at IS NOT NULL`);
