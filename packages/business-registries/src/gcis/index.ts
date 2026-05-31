export { lookupByTaxId, searchByName } from "./client.js";
export type { SearchOptions } from "./client.js";
export {
  GcisAPIError,
  GcisError,
  GcisNotFoundError,
  GcisRequestError,
  GcisValidationError,
} from "./errors.js";
export { parseCompany, parseSearchEntry } from "./parse.js";
export type {
  GcisCompany,
  GcisCompanyStatus,
  GcisRawCompany,
  GcisResponse,
  GcisSearchResult,
} from "./types.js";
export { normalizeTaxId, validateTaxId } from "./validation.js";
