export {
  lookupByCompanyNumber,
  lookupOfficersByCompanyNumber,
  searchByName,
} from "./client.js";
export type { CompaniesHouseClientConfig, SearchOptions } from "./client.js";
export {
  CompaniesHouseAPIError,
  CompaniesHouseAuthError,
  CompaniesHouseError,
  CompaniesHouseNotFoundError,
  CompaniesHouseRequestError,
  CompaniesHouseValidationError,
} from "./errors.js";
export {
  parseAddress,
  parseCompanyProfile,
  parseOfficer,
  parseOfficersResponse,
  parseSearchItem,
  parseSearchResponse,
} from "./parse.js";
export type {
  CompaniesHouseAccounts,
  CompaniesHouseAddress,
  CompaniesHouseCompany,
  CompaniesHouseConfirmationStatement,
  CompaniesHouseEntityStatus,
  CompaniesHouseOfficer,
  CompaniesHousePreviousName,
  CompaniesHouseRawAccounts,
  CompaniesHouseRawAddress,
  CompaniesHouseRawCompanyProfile,
  CompaniesHouseRawConfirmationStatement,
  CompaniesHouseRawOfficer,
  CompaniesHouseRawOfficersResponse,
  CompaniesHouseRawPreviousName,
  CompaniesHouseRawSearchItem,
  CompaniesHouseRawSearchResponse,
  CompaniesHouseSearchResult,
} from "./types.js";
export { normalizeCompanyNumber, validateCompanyNumber } from "./validation.js";
