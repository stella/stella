/**
 * Website access, requested together with the downloads API in one user
 * gesture. Only HTTPS: the origin policy refuses plain HTTP, so the grant
 * never needs it. `downloads` is used only to cancel downloads a controlled
 * page starts from script (`blob:`/`data:` URLs), which network rules never
 * see; commands refuse to run without it.
 */
const SITE_ACCESS = {
  origins: ["https://*/*"],
  permissions: ["downloads"],
} satisfies chrome.permissions.Permissions;

export const hasAllSiteAccess = async (): Promise<boolean> =>
  await chrome.permissions.contains(SITE_ACCESS);

export const requestAllSiteAccess = async (): Promise<boolean> =>
  await chrome.permissions.request(SITE_ACCESS);

export const removeAllSiteAccess = async (): Promise<boolean> =>
  await chrome.permissions.remove(SITE_ACCESS);
