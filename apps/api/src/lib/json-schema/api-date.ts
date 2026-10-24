import { parsePlainDate } from "@stll/time";

/** PostgreSQL-backed API dates use four-digit CE years, without a timezone. */
export const isApiDate = (value: string): boolean => {
  const date = parsePlainDate(value);
  return date !== null && date.year > 0;
};
