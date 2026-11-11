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
} as const;
