import { TIME_ENTRY_RATE_REQUIRED_CODE } from "@stll/api-contract/time-entries";

import { APIError } from "@/lib/errors/api";

export const isTimeEntryRateRequired = (error: unknown): boolean =>
  APIError.is(error) &&
  error.status === 400 &&
  error.code === TIME_ENTRY_RATE_REQUIRED_CODE;
