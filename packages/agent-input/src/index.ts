// One lenient reader per value kind a model writes on the wire, and the one
// ask-for-a-fix shape they all answer with.
export { normalizeBoolean } from "./boolean";
export {
  DATE_FORMAT_SPEC_HINT,
  normalizeDateFormatSpec,
} from "./date-format-spec";
export { DATE_VALUE_HINT, normalizeDateValue } from "./date-value";
export { normalizeEnumValue } from "./enum-value";
export { isPlausibleLocale, normalizeLocale } from "./locale";
export type { Normalized } from "./normalized";
export { askSentence } from "./normalized";
export { normalizeNumber } from "./number";
export {
  AGENT_INPUT_NORMALIZATION_KEY,
  AGENT_INPUT_NORMALIZATION_KIND,
  agentInputNormalization,
  agentInputNormalizationGuidance,
  agentInputNormalizationMetadata,
  normalizeAgentInput,
} from "./schema";
export type {
  AgentInputNormalizationAnnotation,
  AgentInputNormalizationIssue,
  AgentInputNormalizationKind,
  AgentInputNormalizationResult,
} from "./schema";
