export { lookupBySiren, lookupBySiret, searchByName } from "./client.js";
export type { SearchOptions } from "./client.js";
export {
  RechercheEntreprisesAPIError,
  RechercheEntreprisesError,
  RechercheEntreprisesNotFoundError,
  RechercheEntreprisesRequestError,
  RechercheEntreprisesValidationError,
} from "./errors.js";
export {
  parseAddress,
  parseCompany,
  parseEstablishment,
  parseSearchEntry,
} from "./parse.js";
export type {
  RechercheEntreprisesAddress,
  RechercheEntreprisesCompany,
  RechercheEntreprisesDirector,
  RechercheEntreprisesErrorResponse,
  RechercheEntreprisesEstablishment,
  RechercheEntreprisesEstablishmentStatus,
  RechercheEntreprisesLegalEntityStatus,
  RechercheEntreprisesRawDirigeant,
  RechercheEntreprisesRawDirigeantOrganisation,
  RechercheEntreprisesRawDirigeantPerson,
  RechercheEntreprisesRawEtablissement,
  RechercheEntreprisesRawUniteLegale,
  RechercheEntreprisesSearchResponse,
  RechercheEntreprisesSearchResult,
} from "./types.js";
export {
  hasCanonicalShape,
  normalizeSiren,
  validateSiren,
  validateSiret,
} from "./validation.js";
