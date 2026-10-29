import * as v from "valibot";

import {
  EXPENSE_CATEGORIES,
  TIME_ENTRY_SOURCES,
  TIME_ENTRY_STATUSES,
} from "@stll/api-contract";

export const timeEntryStatusSchema = v.picklist(TIME_ENTRY_STATUSES);

export const timeEntrySourceSchema = v.picklist(TIME_ENTRY_SOURCES);

export const expenseCategorySchema = v.picklist(EXPENSE_CATEGORIES);
