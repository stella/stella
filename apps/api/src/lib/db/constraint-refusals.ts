import { SKILL_PACKAGE_REFUSAL_CODE } from "@stll/api-contract";
import { MATTER_STEWARD_HANDOVER_REQUIRED_CODE } from "@stll/api-contract/matter-visibility";
import { SKILL_PACKAGE_LIMITS } from "@stll/skills/format";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isPgConstraintError, PG_ERROR } from "@/api/lib/pg-error";

/**
 * Constraint the stewardship triggers refuse a change under: it would leave
 * an assigned-only matter without an assigned internal member.
 */
export const MATTER_STEWARD_CONSTRAINT = "workspaces_assigned_only_steward";

/** Constraint the skill package size trigger refuses a write under. */
export const SKILL_PACKAGE_SIZE_CONSTRAINT =
  "agent_skill_resources_package_size";

const MIB = 1024 * 1024;

/**
 * Database refusals that are the caller's to act on, not faults: a trigger
 * or check that guards a limit every writer must keep. Each is answered with
 * its own status wherever the refused write came from, so no write path has
 * to remember to translate it.
 */
const DATABASE_CONSTRAINT_REFUSALS = [
  {
    constraint: MATTER_STEWARD_CONSTRAINT,
    sqlState: PG_ERROR.CHECK_VIOLATION,
    refusal: (cause: unknown) =>
      new HandlerError({
        cause,
        status: 409,
        code: MATTER_STEWARD_HANDOVER_REQUIRED_CODE,
        message:
          "A matter visible to assigned members only must keep at least one assigned internal member.",
        hint: "Assign another internal member to the matter, or widen its visibility, then try again.",
      }),
  },
  {
    constraint: SKILL_PACKAGE_SIZE_CONSTRAINT,
    sqlState: PG_ERROR.CHECK_VIOLATION,
    refusal: (cause: unknown) =>
      new HandlerError({
        cause,
        status: 413,
        code: SKILL_PACKAGE_REFUSAL_CODE.tooLarge,
        message: `A skill's files may take at most ${String(SKILL_PACKAGE_LIMITS.packageFilesMaxBytes / MIB)} MiB together`,
        hint: "Remove or shorten some of the skill's files, then try again.",
      }),
  },
] as const;

/** The client refusal a database error stands for, or null. */
export const databaseConstraintRefusal = (
  error: unknown,
): HandlerError | null => {
  for (const {
    constraint,
    refusal,
    sqlState,
  } of DATABASE_CONSTRAINT_REFUSALS) {
    if (isPgConstraintError(error, sqlState, constraint)) {
      return refusal(error);
    }
  }
  return null;
};
