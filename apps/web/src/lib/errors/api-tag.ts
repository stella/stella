// The tags of the client's API and auth errors, in a leaf module so telemetry
// can recognize the classes structurally without importing the localized
// error modules (which reach back into analytics through i18n).
export const API_ERROR_TAG = "ApiError";
export const AUTH_CLIENT_ERROR_TAG = "AuthClientError";
