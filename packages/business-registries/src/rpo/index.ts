export { lookupByIco, searchByName } from "./client.js";
export type { SearchOptions } from "./client.js";
export {
  RpoAPIError,
  RpoError,
  RpoNotFoundError,
  RpoRequestError,
  RpoValidationError,
} from "./errors.js";
export { parseAddress, parseCompany, parseSearchEntry } from "./parse.js";
export type {
  RpoActivity,
  RpoAddress,
  RpoCodelistValue,
  RpoCompany,
  RpoCompanyStatus,
  RpoDomainActivity,
  RpoDomainAddress,
  RpoDomainCourtFile,
  RpoDomainName,
  RpoDomainStatutoryBody,
  RpoErrorResponse,
  RpoIdentifier,
  RpoLegalForm,
  RpoName,
  RpoPersonName,
  RpoRawEntity,
  RpoRegistrationNumber,
  RpoRegistrationOffice,
  RpoSearchResponse,
  RpoSearchResult,
  RpoSourceRegister,
  RpoStatisticalCodes,
  RpoStatutoryBody,
  RpoValidityWindow,
} from "./types.js";
export { normalizeIco, validateIco } from "./validation.js";
