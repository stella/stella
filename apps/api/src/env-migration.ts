import { Result, TaggedError } from "better-result";
import * as v from "valibot";

const manualDrainReasonSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(1000),
  v.brand("MigrationManualDrainReason"),
);

export const envMigrationServerSchema = {
  MIGRATE_MANUAL_DRAIN_CONFIRMED: v.optional(manualDrainReasonSchema),
};

export type MigrationDrainConfirmation =
  | { type: "automatic" }
  | { type: "manual"; reason: v.InferOutput<typeof manualDrainReasonSchema> };

export class InvalidMigrationDrainConfirmation extends TaggedError(
  "InvalidMigrationDrainConfirmation",
)<{ message: string }> {}

/** An explicit reason attests that the operator completed the manual scheduler drain. */
export const parseMigrationDrainConfirmation = (
  reason: string | undefined,
): Result<MigrationDrainConfirmation, InvalidMigrationDrainConfirmation> => {
  const parsed = v.safeParse(
    envMigrationServerSchema.MIGRATE_MANUAL_DRAIN_CONFIRMED,
    reason,
  );
  if (!parsed.success) {
    return Result.err(
      new InvalidMigrationDrainConfirmation({
        message:
          "MIGRATE_MANUAL_DRAIN_CONFIRMED requires a non-empty reason of at most 1000 characters",
      }),
    );
  }
  return Result.ok(
    parsed.output === undefined
      ? { type: "automatic" }
      : { type: "manual", reason: parsed.output },
  );
};
