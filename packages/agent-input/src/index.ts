// One lenient reader per value kind a model writes on the wire, and the one
// ask-for-a-fix shape they all answer with.
export { ABSENT_PLACEHOLDERS, isAbsentPlaceholder } from "./absent";
export { normalizeBoolean } from "./boolean";
export {
  COUNTRY_INPUT_MAX_CHARS,
  countryCodeIn,
  normalizeCountry,
} from "./country";
export type {
  CountryAlpha2,
  CountryAlpha3,
  CountryOptions,
  CountrySpelling,
  CountryValue,
} from "./country";
export {
  DATE_FORMAT_SPEC_HINT,
  normalizeDateFormatSpec,
} from "./date-format-spec";
export {
  DATE_VALUE_HINT,
  normalizeDateBound,
  normalizeDateValue,
} from "./date-value";
export type {
  DateBound,
  DateBoundOptions,
  DateValueOptions,
} from "./date-value";
export { normalizeEli } from "./eli";
export type { EliOptions } from "./eli";
export { normalizeEnumValue } from "./enum-value";
export { isPlausibleLocale, normalizeLocale } from "./locale";
export type {
  Normalized,
  NormalizedAbsent,
  NormalizedAsk,
  NormalizedOptional,
} from "./normalized";
export { askForFix, askSentence, readAsAbsent } from "./normalized";
export { normalizeNumber, normalizeNumberInRange } from "./number";
export type { NumberInRangeOptions, NumberOptions } from "./number";
export { normalizeStringList } from "./string-list";
export type { StringListOptions } from "./string-list";
export { isSentinelUuid, normalizeUuid, SENTINEL_UUIDS } from "./uuid";
export type { UuidOptions } from "./uuid";
export { normalizeVocabularyValue } from "./vocabulary";
export type { VocabularyEntry, VocabularyOptions } from "./vocabulary";
export {
  AGENT_INPUT_NORMALIZATION_KEY,
  AGENT_INPUT_NORMALIZATION_KIND,
  agentInputNormalization,
  agentInputNormalizationGuidance,
  agentInputNormalizationMetadata,
  normalizeAgentInput,
} from "./schema";
export type {
  AgentInputPlaceholderPolicy,
  AgentInputReaders,
  AgentInputCountryAnnotation,
  AgentInputNormalizationAnnotation,
  AgentInputNormalizationIssue,
  AgentInputNormalizationKind,
  AgentInputNormalizationResult,
} from "./schema";
