import { TaggedError } from "better-result";

import type { LEGAL_HOLD_ACTIVE } from "@stll/api-contract/legal-holds";

import type { LegalHoldRecord } from "./projection";

/** An active hold a refusal names; clients see it only through its `view`. */
export type HoldSummary = LegalHoldRecord;

export class LegalHoldActiveError extends TaggedError("LegalHoldActiveError")<{
  message: string;
  code: typeof LEGAL_HOLD_ACTIVE;
  holds: HoldSummary[];
}> {}
