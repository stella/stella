/**
 * Website access, requested in one user gesture together with the two APIs
 * containment needs; commands refuse to run without all of them. Only HTTPS:
 * the origin policy refuses plain HTTP, so the grant never needs it.
 * `downloads` cancels downloads a controlled page starts from script
 * (`blob:`/`data:` URLs), which network rules never see. `webNavigation`
 * names the page that opened a new tab, and the frames a controlled tab
 * holds, so a page-opened tab stays confined and a download is traced to
 * the frame that started it.
 */
const SITE_ACCESS = {
  origins: ["https://*/*"],
  permissions: ["downloads", "webNavigation"],
} satisfies chrome.permissions.Permissions;

export const hasAllSiteAccess = async () =>
  await chrome.permissions.contains(SITE_ACCESS);

export const requestAllSiteAccess = async () =>
  await chrome.permissions.request(SITE_ACCESS);

export const removeAllSiteAccess = async () =>
  await chrome.permissions.remove(SITE_ACCESS);

/**
 * Talking to stella desktop on this computer, requested on its own from the
 * popup: only members who run coding agents locally need it.
 */
const DESKTOP_LINK_ACCESS = {
  permissions: ["nativeMessaging"],
} satisfies chrome.permissions.Permissions;

export const hasDesktopLinkAccess = async () =>
  await chrome.permissions.contains(DESKTOP_LINK_ACCESS);

export const requestDesktopLinkAccess = async () =>
  await chrome.permissions.request(DESKTOP_LINK_ACCESS);
