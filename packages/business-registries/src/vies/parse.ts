import type {
  ViesRawResponse,
  ViesValidation,
  ViesValidationStatus,
  ViesVatNumber,
} from "./types.js";

// Several VIES member-state services suppress trader data even for
// valid records. Those responses come back with the literal "---" in
// `name`/`address`. Normalise to null so downstream consumers do not
// have to handle the sentinel.
const VIES_BLANK_SENTINEL = "---";

const normalizeBlank = (value: string): string | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === VIES_BLANK_SENTINEL) {
    return null;
  }
  return trimmed;
};

const SERVICE_UNAVAILABLE_USER_ERRORS = new Set<string>([
  "SERVICE_UNAVAILABLE",
  "MS_UNAVAILABLE",
  "TIMEOUT",
  "SERVER_BUSY",
  "GLOBAL_MAX_CONCURRENT_REQ",
  "MS_MAX_CONCURRENT_REQ",
]);

const deriveStatus = (raw: ViesRawResponse): ViesValidationStatus => {
  if (raw.isValid && raw.userError === "VALID") {
    return { type: "valid" };
  }
  if (raw.userError === "INVALID_INPUT") {
    return { type: "invalid-format" };
  }
  if (SERVICE_UNAVAILABLE_USER_ERRORS.has(raw.userError)) {
    return { type: "service-unavailable", userError: raw.userError };
  }
  // Only the explicit `INVALID` user-error is a real negative
  // validation. Any uncatalogued non-success value (a new transient
  // fault we haven't enumerated yet, an `MS_*` variant the upstream
  // adds in future) is conservatively classified as
  // service-unavailable — surfacing an unknown outage as
  // "not-registered" would falsely tell users their counterparty's
  // VAT is dead.
  if (raw.userError === "INVALID") {
    return { type: "not-registered" };
  }
  return { type: "service-unavailable", userError: raw.userError };
};

export const parseValidation = (
  raw: ViesRawResponse,
  vatNumber: ViesVatNumber,
): ViesValidation => {
  const status = deriveStatus(raw);
  return {
    vatNumber,
    valid: status.type === "valid",
    status,
    requestDate: raw.requestDate,
    name: normalizeBlank(raw.name),
    address: normalizeBlank(raw.address),
  };
};
