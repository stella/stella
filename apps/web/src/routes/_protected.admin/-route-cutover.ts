const ADMIN_PREFIX = "/admin";
const ORGANIZATION_SETTINGS_PREFIX = "/settings/organization";

/** Preserves the legacy section suffix while moving organization administration
 * into the single Settings destination. */
export const legacyAdminSettingsDestination = (pathname: string) => {
  const suffix = pathname.slice(ADMIN_PREFIX.length);
  return `${ORGANIZATION_SETTINGS_PREFIX}${suffix || "/general"}`;
};
