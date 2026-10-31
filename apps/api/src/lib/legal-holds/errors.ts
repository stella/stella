import { TaggedError } from "better-result";

import type { LEGAL_HOLD_ACTIVE } from "@stll/api-contract/legal-holds";

import type { SafeId } from "@/api/lib/branded-types";

export type HoldSummary = {
  id: SafeId<"legalHold">;
  scope: "matter" | "entity";
  workspaceId: SafeId<"workspace">;
  placedAt: Date;
};

export class LegalHoldActiveError extends TaggedError("LegalHoldActiveError")<{
  message: string;
  code: typeof LEGAL_HOLD_ACTIVE;
  holds: HoldSummary[];
}> {}
