import { eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
  organizationSettings,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { moveKeylessOrganizationsToFree } from "@/api/lib/usage/organization-access-state";

export const KEYLESS_ORGANIZATION_MOVE_OUTCOME = {
  wouldMove: "would_move",
  keepsOwnKey: "keeps_own_key",
  otherState: "other_state",
  moved: "moved",
} as const;

type DryRunOutcome = (typeof KEYLESS_ORGANIZATION_MOVE_OUTCOME)[keyof Pick<
  typeof KEYLESS_ORGANIZATION_MOVE_OUTCOME,
  "wouldMove" | "keepsOwnKey" | "otherState"
>];

export type KeylessOrganizationMoveResult = {
  organizationId: SafeId<"organization">;
  outcome: DryRunOutcome | typeof KEYLESS_ORGANIZATION_MOVE_OUTCOME.moved;
};

const classifyOutcome = (
  state: (typeof organizationAccessStates.$inferSelect)["state"],
  aiConfigEncrypted: Buffer | null,
): DryRunOutcome => {
  if (state !== ORGANIZATION_ACCESS_STATE.selfManagedKeys) {
    return KEYLESS_ORGANIZATION_MOVE_OUTCOME.otherState;
  }
  return aiConfigEncrypted === null
    ? KEYLESS_ORGANIZATION_MOVE_OUTCOME.wouldMove
    : KEYLESS_ORGANIZATION_MOVE_OUTCOME.keepsOwnKey;
};

export const classifyKeylessOrganizationMoves = async (
  db: Pick<Transaction, "select">,
): Promise<KeylessOrganizationMoveResult[]> => {
  const rows = await db
    .select({
      organizationId: organizationAccessStates.organizationId,
      state: organizationAccessStates.state,
      aiConfigEncrypted: organizationSettings.aiConfigEncrypted,
    })
    .from(organizationAccessStates)
    .leftJoin(
      organizationSettings,
      eq(
        organizationSettings.organizationId,
        organizationAccessStates.organizationId,
      ),
    );

  return rows.map(({ organizationId, state, aiConfigEncrypted }) => ({
    organizationId,
    outcome: classifyOutcome(state, aiConfigEncrypted),
  }));
};

export const applyKeylessOrganizationMoves = async (
  db: Transaction,
  options: Parameters<typeof moveKeylessOrganizationsToFree>[1],
): Promise<KeylessOrganizationMoveResult[]> =>
  (await moveKeylessOrganizationsToFree(db, options)).map((organizationId) => ({
    organizationId,
    outcome: KEYLESS_ORGANIZATION_MOVE_OUTCOME.moved,
  }));
