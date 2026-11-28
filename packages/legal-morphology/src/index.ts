export {
  CaseLawDocumentLanguageUndeclaredError,
  caseLawDocumentStemLanguage,
  caseLawDocumentStemLanguages,
  CORPUS_MORPHOLOGY_LANGUAGES,
  corpusMorphologyLanguage,
  documentMorphologyLanguage,
} from "./corpus-language";
export {
  corpusTokens,
  corpusTokenSpans,
  normalizeCorpusText,
} from "./corpus-tokens";
export type { CorpusTokenSpan } from "./corpus-tokens";
export {
  foldExpansionKey,
  NO_EXPANSION_DICTIONARY_IDENTITY,
  parseExpansionDictionary,
  parseExpansionDictionaryOffLoop,
  serializeExpansionDictionary,
} from "./dictionary";
export type {
  ExpansionDictionaryIdentity,
  ParsedExpansionDictionary,
} from "./dictionary";
export {
  FUNCTION_WORDS,
  functionWordKey,
  functionWordsFor,
} from "./function-words";
export { stemSlovak, stemSlovakUpstream } from "./slovak";
export {
  GLOBAL_MORPHOLOGY_KEY,
  MORPHOLOGY_LANGUAGES,
  morphologyKey,
  queryStems,
  stemLegalTerm,
} from "./stem";
export type { MorphologyLanguage } from "./stem";
export { stemCorpusText } from "./stem-text";
