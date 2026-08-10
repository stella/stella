import { t } from "elysia";

import {
  EXPENSE_CATEGORIES,
  TIME_ENTRY_SOURCES,
  TIME_ENTRY_STATUSES,
} from "@stll/api-contract";
import type {
  ExpenseCategory,
  TimeEntrySource,
  TimeEntryStatus,
} from "@stll/api-contract";

export const timeEntryStatusSchema = t.UnionEnum(TIME_ENTRY_STATUSES);

export const timeEntrySourceSchema = t.UnionEnum(TIME_ENTRY_SOURCES);

export const expenseCategorySchema = t.UnionEnum(EXPENSE_CATEGORIES);

export type { ExpenseCategory, TimeEntrySource, TimeEntryStatus };
