export type ApplicationRlsRolePosture = {
  canLogin: boolean;
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
  if (posture.ownsRlsTable) {
    return "Application RLS role must not own RLS-protected tables.";
  }
  return null;
};
