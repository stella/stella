import { Result, TaggedError } from "better-result";

import { declareFingerprintFields } from "@stll/errors";
import { RUNTIME_MODE, type RuntimeMode } from "@stll/runtime-mode";

export type ApplicationRlsRolePosture = {
  bypassesRls: boolean;
  canAssumeRole: boolean;
  canLogin: boolean;
  isSuperuser: boolean;
  ownsRlsTable: boolean;
};

export const applicationRlsRolePostureViolation = (
  posture: ApplicationRlsRolePosture | undefined,
): string | null => {
  if (posture === undefined) {
    return "Application RLS role is missing.";
  }
  if (posture.canLogin) {
    return "Application RLS role must not permit login.";
  }
  if (posture.isSuperuser || posture.bypassesRls) {
    return "Application RLS role must not bypass row security.";
  }
  if (posture.ownsRlsTable) {
    return "Application RLS role must not own RLS-protected tables.";
  }
  if (!posture.canAssumeRole) {
    return "Database login must be able to assume the application RLS role.";
  }
  return null;
};

export type IngestionRolePosture = Pick<
  ApplicationRlsRolePosture,
  "canAssumeRole"
>;

export const ingestionRolePostureViolation = (
  posture: IngestionRolePosture | undefined,
): string | null => {
  if (posture === undefined) {
    return "Ingestion role is missing.";
  }
  if (!posture.canAssumeRole) {
    return "Database login must be able to assume the ingestion role. Run `bun run db:migrate` to grant SET rights.";
  }
  return null;
};

/** Role attributes of the database login the process connects with. */
export type DatabaseLoginPosture = {
  loginName: string;
  bypassesRls: boolean;
  isSuperuser: boolean;
  ownedPolicyTables: number;
};

/**
 * The login attributes recorded at startup, so each deployment's role layout
 * is visible in its logs. Empty when the login holds none of them.
 */
export const databaseLoginPostureNotes = (
  posture: DatabaseLoginPosture,
): string[] => {
  const notes: string[] = [];
  if (posture.isSuperuser) {
    notes.push("login is a superuser");
  }
  if (posture.bypassesRls) {
    notes.push("login has elevated role attributes");
  }
  if (posture.ownedPolicyTables > 0) {
    notes.push(
      `login owns ${String(posture.ownedPolicyTables)} tables with row-level policies`,
    );
  }
  return notes;
};

export const UNSAFE_DATABASE_LOGIN_LOCAL_DEV_ENV =
  "STELLA_ALLOW_PRIVILEGED_DB_LOGIN_FOR_LOCAL_DEV";

const DATABASE_LOGIN_REFUSAL = {
  localDevSetting: "unsafe_local_development_setting",
  unavailable: "role_attributes_unavailable",
  privileged: "privileged_login",
} as const;

type DatabaseLoginRefusal =
  (typeof DATABASE_LOGIN_REFUSAL)[keyof typeof DATABASE_LOGIN_REFUSAL];

export class DatabaseLoginPostureError extends TaggedError(
  "DatabaseLoginPostureError",
)<{ message: string; reason: DatabaseLoginRefusal }> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

type DatabaseLoginPostureOptions = {
  posture: DatabaseLoginPosture | undefined;
  runtimeMode: RuntimeMode;
  unsafeLocalDevOptIn: string | undefined;
};

/** A login is accepted only after its role attributes have been inspected. */
export const databaseLoginPostureResult = ({
  posture,
  runtimeMode,
  unsafeLocalDevOptIn,
}: DatabaseLoginPostureOptions): Result<void, DatabaseLoginPostureError> => {
  if (
    unsafeLocalDevOptIn !== undefined &&
    unsafeLocalDevOptIn !== "" &&
    (unsafeLocalDevOptIn !== "1" || runtimeMode.mode !== RUNTIME_MODE.open)
  ) {
    return Result.err(
      new DatabaseLoginPostureError({
        reason: DATABASE_LOGIN_REFUSAL.localDevSetting,
        message: `${UNSAFE_DATABASE_LOGIN_LOCAL_DEV_ENV}=1 requires an explicitly enabled local development runtime.`,
      }),
    );
  }
  if (posture === undefined) {
    return Result.err(
      new DatabaseLoginPostureError({
        reason: DATABASE_LOGIN_REFUSAL.unavailable,
        message:
          "Database login role attributes must be available before startup.",
      }),
    );
  }
  if (
    (posture.isSuperuser || posture.bypassesRls) &&
    unsafeLocalDevOptIn !== "1"
  ) {
    return Result.err(
      new DatabaseLoginPostureError({
        reason: DATABASE_LOGIN_REFUSAL.privileged,
        message:
          "Database login requires NOSUPERUSER NOBYPASSRLS role attributes.",
      }),
    );
  }
  return Result.ok(undefined);
};
