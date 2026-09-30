import { parsePlainDate } from "@stll/time";

import type { AbsenceRequest } from "@/lib/organization/absences";

export type AbsenceFormValues = {
  kind: AbsenceRequest["kind"];
  startDate: string;
  lastDay: string;
  coverage: AbsenceRequest["coverage"];
};

export const initialAbsenceValues = (date: string): AbsenceFormValues => ({
  kind: "vacation",
  startDate: date,
  lastDay: date,
  coverage: { type: "full" },
});

export const absenceRequestFromForm = (
  values: AbsenceFormValues,
  timezoneId: string,
) => {
  const start = parsePlainDate(values.startDate);
  const last = parsePlainDate(values.lastDay);
  if (!start || !last || values.startDate > values.lastDay) {
    return { type: "invalid", reason: "range" } as const;
  }
  if (values.coverage.type === "half" && values.startDate !== values.lastDay) {
    return { type: "invalid", reason: "half_range" } as const;
  }
  const body = {
    kind: values.kind,
    startDate: start.toString(),
    endDate: last.add({ days: 1 }).toString(),
    timezoneId,
    coverage: values.coverage,
  } satisfies AbsenceRequest;
  return { type: "valid", body } as const;
};

export const canRejectAbsence = (comment: string) =>
  comment.trim().length > 0 && comment.length <= 2000;
