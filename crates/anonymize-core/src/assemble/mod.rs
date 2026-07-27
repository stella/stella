//! Stage-1 native-config assembly foundation.
//!
//! This module hosts the serde input structs that mirror the TypeScript
//! pipeline config/data types and the embedded canonical data config tree. The
//! assembler itself (which produces the binding-facing prepared search config)
//! lives in the `stella-anonymize-adapter-contract` crate, because that crate
//! owns the output contract type; the core crate cannot depend on it without a
//! dependency cycle.
//!
//! Ported from `packages/anonymize/src/build-unified-search.ts`
//! (`buildNativeStaticSearchBundle`).

pub mod config;
pub mod data;
pub mod dictionaries;
mod error;
pub mod gazetteer;

pub use config::{
  CustomDenyListEntry, CustomRegexPattern, DenyListCategory, DictionaryMeta,
  PipelineConfig, PreparedArtifactPolicy, StandaloneStreetDetection,
};
pub use data::{
  OrderedMap, data_file, parse_data_file, parse_ordered_data_file,
};
pub use dictionaries::Dictionaries;
pub use error::AssembleError;
pub use gazetteer::{GazetteerEntry, GazetteerSource};
