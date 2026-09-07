import { describe, expect, test } from "bun:test";

import { resolveDateFields } from "@/api/lib/docx/date-fields";
import type { FieldMeta } from "@/api/lib/docx/types";

import { runFillValues } from "./run-fill-values";

/** A task fixture as the eval declares it: one loop whose rows carry the date
 *  field, which is where the engine's in-place formatting bites. */
const TASK_FILL_VALUES = {
  deliverables: [
    { item: "Site survey", due_date: "2026-10-01" },
    { item: "Final handover", due_date: "2026-11-01" },
  ],
};

const DELIVERABLE_DUE_DATE: FieldMeta = {
  path: "deliverables.due_date",
  inputType: "date",
  dateFormat: { locale: "en", style: "long" },
};

const dueDates = (values: Record<string, unknown>): unknown[] => {
  const rows = values["deliverables"];
  return Array.isArray(rows)
    ? rows.map((row: Record<string, unknown>) => row["due_date"])
    : [];
};

describe("runFillValues", () => {
  test("a second run over the same task still submits ISO dates", () => {
    const first = runFillValues(TASK_FILL_VALUES);
    expect(
      resolveDateFields({ values: first, fields: [DELIVERABLE_DUE_DATE] }),
    ).toEqual([]);
    expect(dueDates(first)).toEqual(["October 1, 2026", "November 1, 2026"]);

    const second = runFillValues(TASK_FILL_VALUES);
    expect(dueDates(second)).toEqual(["2026-10-01", "2026-11-01"]);
    expect(
      resolveDateFields({ values: second, fields: [DELIVERABLE_DUE_DATE] }),
    ).toEqual([]);
    expect(dueDates(second)).toEqual(["October 1, 2026", "November 1, 2026"]);
  });

  test("the task fixture the runs share is left as it was declared", () => {
    resolveDateFields({
      values: runFillValues(TASK_FILL_VALUES),
      fields: [DELIVERABLE_DUE_DATE],
    });
    expect(dueDates(TASK_FILL_VALUES)).toEqual(["2026-10-01", "2026-11-01"]);
  });
});
