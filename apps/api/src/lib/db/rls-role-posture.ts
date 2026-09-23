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
