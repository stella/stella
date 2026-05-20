export {
  findRelatedLaws,
  getBormeSummary,
  getBoeSummary,
  getConsolidatedLaw,
  getLawStructure,
  getLawTextBlock,
  RELATION_TYPES,
  searchConsolidatedLegislation,
} from "./client.js";
export type {
  GetConsolidatedLawOptions,
  RelatedLawsResult,
  RelationType,
  SearchLegislationOptions,
} from "./client.js";
export {
  BoeAPIError,
  BoeError,
  BoeNotFoundError,
  BoeRequestError,
  BoeValidationError,
} from "./errors.js";
export { buildSearchQuery } from "./query.js";
export type { BoeSearchQuery } from "./query.js";
export type {
  BoeErrorResponse,
  BoeLawEnvelope,
  BoeSearchHit,
  BoeSearchResponse,
  BoeStatus,
  BormeAnnouncement,
  BormeDailyIssue,
  BormeProvincialSection,
  BormeSectionGroup,
  BormeSummaryResponse,
  ConsolidatedLawResult,
  ConsolidatedLawSections,
} from "./types.js";
export { toBoeDate, validateBoeDate, validateLawId } from "./validation.js";
