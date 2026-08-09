export type ApplicationRlsRolePosture = {
  bypassesRls: boolean;
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
  return null;
};
