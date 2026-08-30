#![allow(clippy::redundant_pub_crate)]

//! Core anonymization contracts shared by host-language bindings.

mod address_context;
mod address_seeds;
mod anchored;
mod artifact_bytes;
/// Stage-1 native-config assembly inputs and embedded canonical data.
pub mod assemble;
pub(crate) mod bounded_regex;
pub(crate) mod byte_offsets;
mod coreference;
mod dates;
mod diagnostics;
/// Cross-crate concurrency seam: scoped OS threads on native, sequential
/// execution on WebAssembly. Public for reuse by workspace binding crates.
#[doc(hidden)]
pub mod exec;
mod false_positives;
mod hotwords;
pub(crate) mod labels;
mod legal_forms;
mod money;
mod name_corpus;
pub(crate) mod normalize;
mod placeholders;
mod prepared;
mod prepared_metadata;
mod processors;
mod redact;
mod resolution;
mod search;
mod session;
mod session_archive;
mod signatures;
mod span_index;
mod triggers;
mod types;
mod validators;
mod zones;

pub use address_context::AddressContextData;
pub use address_seeds::{AddressSeedData, StandaloneStreetData};
pub use coreference::{CoreferenceData, CoreferencePatternData};
pub use dates::DateData;
pub use diagnostics::{
  DiagnosticDetail, DiagnosticEvent, DiagnosticEventKind, DiagnosticPhase,
  DiagnosticScope, DiagnosticStage, StaticRedactionDiagnostics,
};
pub use hotwords::{HotwordRule, HotwordRuleData};
pub use legal_forms::{LegalFormData, LowercaseBridge};
pub use money::{
  AmountWordsData, CurrencyData, MagnitudeSuffixData, MonetaryData,
  NumberWordData, ShareQuantityTermData, WrittenAmountPatternData,
};
pub use name_corpus::{NameCorpusData, NameCorpusMode, PreparedNameCorpusData};
pub use normalize::normalize_for_search;
pub use placeholders::build_placeholder_map;
pub use prepared::{
  CallerRedactionOptions, PreparedEngine, PreparedEngineArtifacts,
  PreparedEngineArtifactsView, PreparedEngineBuildResult, PreparedEngineConfig,
  PreparedEngineDetectorConfig, PreparedEngineMatches,
  PreparedEnginePolicyConfig, PreparedEngineSearchConfig, PreparedEngineSlices,
  PreparedSessionCallerRedactionOptions, PreparedSessionRedactionOptions,
  StaticDetectionResult, StaticEntityLayers, StaticRedactionDiagnosticResult,
  StaticRedactionResult, StaticRedactionStreamEvent,
};
pub use processors::{
  CountryMatchData, CountryVariant, DenyListFilterData, DenyListMatchData,
  DenyListPatternMeta, DenyListPatternMetaSet, GazetteerMatchData,
  PatternSlice, RegexMatchMeta, SigningPlaceGuardData, StringGroups,
  process_country_matches, process_deny_list_matches,
  process_gazetteer_matches, process_regex_matches,
};
pub use redact::{
  RedactTextWithSessionParams, deanonymise, redact_text,
  redact_text_with_session,
};
pub use resolution::{
  BoundaryParams, CallerDetection, CallerDetectionParams, CallerProvenance,
  DetectionSource, PipelineEntity, SourceDetail, enforce_boundary_consistency,
  merge_and_dedup, sanitize_entities,
};
pub use search::{
  FuzzySearchOptions, LiteralSearchOptions, PreparedArtifactPolicy,
  RegexArtifactPolicy, RegexSearchOptions, SearchIndex, SearchIndexArtifacts,
  SearchOptions, SearchPattern,
};
pub use session::{
  REDACTION_SESSION_SCHEMA_VERSION, RedactionSession, SessionDeletionSummary,
  SessionId, SessionLifecycle, SessionMetadata, SessionStatus,
  SessionTimestamp,
};
pub use session_archive::{
  OpenSessionArchiveOptions, REDACTION_SESSION_ARCHIVE_ALGORITHM,
  REDACTION_SESSION_ARCHIVE_KEY_BYTES, REDACTION_SESSION_ARCHIVE_MAX_BYTES,
  REDACTION_SESSION_ARCHIVE_VERSION, SessionArchiveKey,
};
#[doc(hidden)]
pub use signatures::encode_party_role_name_evidence;
pub use signatures::{
  PartyRoleNameEvidenceEncodeError, PersonSpanTerminators, SignatureData,
};
pub use triggers::{
  PERSON_OR_ORGANIZATION_TRIGGER_LABEL, TriggerData, TriggerRule,
  TriggerStrategy, TriggerValidation,
};
pub use types::{
  Entity, EntityKind, Error, MaskConfig, MaskDirection, Operator,
  OperatorConfig, OperatorEntry, OperatorType, PlaceholderEntry,
  PlaceholderMap, REDACTION_TEXT_MAX_BYTES, RedactionEntry,
  RedactionReplacement, RedactionResult, Result, SearchEngine, SearchMatch,
  validate_redaction_text,
};
pub use zones::{ZoneData, ZonePatternData, ZoneSigningClauseData};
