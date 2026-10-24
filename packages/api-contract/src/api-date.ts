import * as v from "valibot";

import { parsePlainDate } from "@stll/time";

/** API calendar dates use four-digit CE years, without a timezone. */
export const isApiDate = (value: string): boolean => {
  const date = parsePlainDate(value);
  return date !== null && date.year > 0;
};

const apiDateCheck = v.check(
  isApiDate,
  "Expected an existing calendar day as YYYY-MM-DD in years 0001 to 9999",
);

/** Calendar validity is a runtime check; published schemas retain format: date. */
export const API_DATE_RUNTIME_ONLY_CHECKS = [apiDateCheck] as const;

/** The strict calendar-date boundary shared by API, desktop and MCP inputs. */
export const vApiDate = v.pipe(v.string(), v.isoDate(), apiDateCheck);
