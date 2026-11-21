/**
 * A browser write names the catalog capability it means to run. The API
 * compares the declared id with the capability that owns the matched route
 * and refuses a mismatch, so a client and the catalog cannot silently disagree
 * about which capability a request runs.
 */
export const CAPABILITY_REQUEST_HEADER = "x-stella-capability";

export const CAPABILITY_REQUEST_ERROR_CODE = "capability_mismatch";
