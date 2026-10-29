// parser-output-unchanged: adapt typed reader failures to the existing callback contract; successful parser values are unchanged.
import { Result } from "better-result";

import type {
  StoredRawReparseOutcome,
  StoredRawReparseValue,
} from "@/api/lib/legal-search/ingestion-types";

/** The replay callback consumes an outcome or a rejected Promise, rather than a Result. */
export const readStoredRawReparseResult = (
  value: StoredRawReparseValue,
): StoredRawReparseOutcome => {
  if ("type" in value) {
    return value;
  }
  if (Result.isError(value)) {
    throw value.error;
  }
  return value.value;
};
