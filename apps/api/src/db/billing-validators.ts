import { t } from "elysia";
import type { Static } from "elysia";

export const timeEntryStatusSchema = t.UnionEnum([
  "draft",
  "approved",
  "billed",
  "written_off",
]);
export type TimeEntryStatus = Static<typeof timeEntryStatusSchema>;

export const timeEntrySourceSchema = t.UnionEnum(["manual", "timer"]);
export type TimeEntrySource = Static<typeof timeEntrySourceSchema>;

export const expenseCategorySchema = t.UnionEnum([
  "filing_fee",
  "expert_witness",
  "travel",
  "printing",
  "courier",
  "other",
]);
export type ExpenseCategory = Static<typeof expenseCategorySchema>;
