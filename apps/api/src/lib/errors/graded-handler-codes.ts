// `HandlerError` codes that carry a failure grade. Every other 5xx
// `HandlerError` grades `unclassified` unless a brand or infrastructure
// evidence in its cause chain names it.
//
// Imports only a type, so the ratchet census of unclassified handler failures
// (`scripts/ratchet.ts`) loads the same list the grader reads.

import type { FailureReason } from "@stll/errors";

export const GRADED_HANDLER_CODE_REASON = {
  PUBLIC_READ_TIMEOUT: "public_read_timeout",
  upstream_unavailable: "upstream_unavailable",
} as const satisfies Record<string, FailureReason>;
