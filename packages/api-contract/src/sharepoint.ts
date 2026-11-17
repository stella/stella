/**
 * Refusal codes of the SharePoint / OneDrive connection. A client localizes a
 * refusal by its code; the English message and hint are for agents and logs.
 */
export const SHAREPOINT_REFUSAL_CODE = {
  /** The caller has not connected a Microsoft account in this organization. */
  notConnected: "sharepoint_not_connected",
  /** The stored grant was revoked or expired; connect the account again. */
  reconnectRequired: "sharepoint_reconnect_required",
  /** Microsoft refused the caller access to the requested site, drive or item. */
  accessDenied: "sharepoint_access_denied",
  /** The site, drive or item does not exist or is not visible to the caller. */
  notFound: "sharepoint_not_found",
  /** Microsoft Graph is throttling the caller; retry after the advised delay. */
  throttled: "sharepoint_throttled",
  /** A pagination cursor that this API did not issue. */
  invalidCursor: "sharepoint_invalid_cursor",
  /** Only files can be imported; folders and notebooks cannot. */
  notAFile: "sharepoint_not_a_file",
  /** The file is larger than a stella document may be. */
  fileTooLarge: "sharepoint_file_too_large",
} as const;

/** How many files one SharePoint import request may name. */
export const SHAREPOINT_IMPORT_MAX_ITEMS = 10;

/** The folder id that names a drive's top level. */
export const SHAREPOINT_ROOT_ITEM_ID = "root";

/**
 * What a drive item is to a picker. `other` covers items that are neither a
 * plain file nor a folder (OneNote notebooks and other packages); they are
 * listed so a folder reads as Microsoft shows it, but cannot be imported.
 */
export const SHAREPOINT_ITEM_KIND = {
  file: "file",
  folder: "folder",
  other: "other",
} as const;

export type SharepointItemKind =
  (typeof SHAREPOINT_ITEM_KIND)[keyof typeof SHAREPOINT_ITEM_KIND];

export type SharepointRefusalCode =
  (typeof SHAREPOINT_REFUSAL_CODE)[keyof typeof SHAREPOINT_REFUSAL_CODE];

/**
 * Why the Microsoft consent callback did not connect, carried as the `reason`
 * query parameter of the redirect back to the web app.
 */
export const SHAREPOINT_OAUTH_CALLBACK_REASONS = [
  "not-enabled",
  "consent-denied",
  "missing-code",
  "expired-state",
  "user-mismatch",
  "not-configured",
  "token-exchange",
  "invalid-secret",
  "unexpected",
] as const;

export type SharepointOAuthCallbackReason =
  (typeof SHAREPOINT_OAUTH_CALLBACK_REASONS)[number];
