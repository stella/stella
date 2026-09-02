// The tag of the client's API error, in a leaf module so telemetry can
// recognize the class structurally without importing the localized error
// module (which reaches back into analytics through i18n).
export const API_ERROR_TAG = "ApiError";
