/** Only HTTPS: the origin policy refuses plain HTTP, so the grant never needs it. */
export const ALL_SITE_ORIGINS = ["https://*/*"] as const;

export const hasAllSiteAccess = async (): Promise<boolean> =>
  await chrome.permissions.contains({ origins: [...ALL_SITE_ORIGINS] });

export const requestAllSiteAccess = async (): Promise<boolean> =>
  await chrome.permissions.request({ origins: [...ALL_SITE_ORIGINS] });

export const removeAllSiteAccess = async (): Promise<boolean> =>
  await chrome.permissions.remove({ origins: [...ALL_SITE_ORIGINS] });
