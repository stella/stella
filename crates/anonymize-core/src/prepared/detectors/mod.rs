use web_time::Instant;

use crate::prepared::detector_contract::{
  StaticDetectorRule, static_detector_modules,
};
use crate::resolution::PipelineEntity;
use crate::types::Result;

use super::timing::{TimedEntities, elapsed_us};

mod prelude;

// New detector modules own their rule metadata and expose a `RULES` slice.
// This module only fixes cross-module execution order.
static_detector_modules! {
  pub(super) const STATIC_DETECTOR_MODULES;
  mod regex;
  mod literal;
  mod anchored;
  mod trigger;
  mod signature;
  mod legal_form;
  mod name_corpus;
  mod address_seed;
}

pub(super) fn static_entity_rules() -> impl Iterator<Item = StaticDetectorRule>
{
  STATIC_DETECTOR_MODULES.iter().copied().flat_map(|module| {
    debug_assert!(!module.name().is_empty(), "detector modules must be named");
    debug_assert!(
      !module.is_empty(),
      "detector module must register at least one rule",
    );
    module.rules().iter().copied()
  })
}

fn timed_entities<F>(detect: F) -> Result<TimedEntities>
where
  F: FnOnce() -> Result<Vec<PipelineEntity>>,
{
  let start = Instant::now();
  let entities = detect()?;
  TimedEntities::new(entities, elapsed_us(start))
}

#[cfg(test)]
mod tests {
  use super::{STATIC_DETECTOR_MODULES, static_entity_rules};
  use crate::prepared::detector_contract::{
    StaticDetectFn, StaticDetectorActiveFn, StaticDetectorId,
    StaticDetectorModule, StaticDetectorRule,
  };

  #[derive(serde::Serialize)]
  struct DetectorRegistrySnapshot {
    modules: Vec<DetectorModuleSnapshot>,
  }

  #[derive(serde::Serialize)]
  struct DetectorModuleSnapshot {
    name: &'static str,
    rules: Vec<DetectorRuleSnapshot>,
  }

  #[derive(serde::Serialize)]
  struct DetectorRuleSnapshot {
    id: String,
    stage: String,
    inputs: Vec<String>,
    dependencies: Vec<String>,
    support_resources: Vec<String>,
    additive_scaling_domains: Vec<String>,
  }

  #[test]
  fn detector_registry_modules_are_named_and_nonempty() {
    let mut module_names = Vec::new();
    for module in STATIC_DETECTOR_MODULES.iter().copied() {
      assert!(!module.name().is_empty(), "detector modules must be named");
      assert!(
        !module.is_empty(),
        "detector module must register at least one rule: {}",
        module.name(),
      );
      assert!(
        !module_names.contains(&module.name()),
        "detector module names must be unique: {}",
        module.name(),
      );
      module_names.push(module.name());
    }
  }

  #[test]
  fn detector_registry_snapshot() {
    insta::assert_yaml_snapshot!(
      "detector_registry",
      detector_registry_snapshot_data()
    );
  }

  #[test]
  fn detector_registry_entries_declare_metadata() {
    let mut ids = Vec::new();
    let mut stages = Vec::new();
    for rule in static_entity_rules() {
      let metadata = rule.spec();
      assert!(
        !ids.contains(&metadata.id()),
        "detector ids must be unique: {:?}",
        metadata.id(),
      );
      assert!(
        !stages.contains(&metadata.diagnostic_stage()),
        "detector diagnostic stages must be unique: {:?}",
        metadata.diagnostic_stage(),
      );
      assert!(
        metadata.has_declared_inputs(),
        "detectors must declare their required inputs",
      );
      assert!(
        metadata.complexity_covers_growing_inputs(),
        "detector complexity contract must cover each growing input exactly once: {:?}",
        metadata.id(),
      );
      let mut dependencies = Vec::new();
      for dependency in metadata.dependencies() {
        assert_ne!(
          metadata.id(),
          *dependency,
          "detectors must not depend on themselves",
        );
        assert!(
          !dependencies.contains(dependency),
          "detector dependencies must be unique: {dependency:?}",
        );
        dependencies.push(*dependency);
        assert!(
          detector_exists(*dependency),
          "detector dependency must be registered: {dependency:?}",
        );
      }
      let mut support_resources = Vec::new();
      for resource in metadata.support_resources() {
        let resource_spec = resource.spec();
        assert!(
          !support_resources.contains(resource),
          "detector support resources must be unique: {resource:?}",
        );
        support_resources.push(*resource);
        let detector_input = resource_spec.detector_input();
        assert!(
          detector_input.is_some(),
          "detector support resource must expose a detector input",
        );
        if let Some(input) = detector_input {
          assert!(
            metadata.declares_input(input),
            "detector support resource input must be derived: {input:?}",
          );
          assert!(
            !metadata.declared_inputs().contains(&input),
            "detector support resource input must not be duplicated: {input:?}",
          );
        }
      }
      ids.push(metadata.id());
      stages.push(metadata.diagnostic_stage());
    }
  }

  #[test]
  fn rule_hooks_are_statically_typed_rust_functions() {
    fn accept_active_hook(_hook: StaticDetectorActiveFn) {}
    fn accept_detect_hook(_hook: StaticDetectFn) {}

    for rule in static_entity_rules() {
      accept_active_hook(rule.active_hook());
      accept_detect_hook(rule.detect_hook());
    }
  }

  #[test]
  fn dependent_detectors_run_after_their_context_sources() {
    for rule in static_entity_rules() {
      let metadata = rule.spec();
      let id = metadata.id();
      for dependency in metadata.dependencies() {
        assert!(
          runs_after(id, *dependency),
          "detector {id:?} must run after dependency {dependency:?}",
        );
      }
    }
  }

  fn runs_after(
    detector: StaticDetectorId,
    dependency: StaticDetectorId,
  ) -> bool {
    match (position_of(detector), position_of(dependency)) {
      (Some(detector_index), Some(dependency_index)) => {
        detector_index > dependency_index
      }
      _ => false,
    }
  }

  fn position_of(detector_id: StaticDetectorId) -> Option<usize> {
    static_entity_rules().position(|rule| rule.spec().id() == detector_id)
  }

  fn detector_exists(detector_id: StaticDetectorId) -> bool {
    static_entity_rules().any(|rule| rule.spec().id() == detector_id)
  }

  fn detector_registry_snapshot_data() -> DetectorRegistrySnapshot {
    DetectorRegistrySnapshot {
      modules: STATIC_DETECTOR_MODULES
        .iter()
        .copied()
        .map(detector_module_snapshot)
        .collect(),
    }
  }

  fn detector_module_snapshot(
    module: StaticDetectorModule,
  ) -> DetectorModuleSnapshot {
    DetectorModuleSnapshot {
      name: module.name(),
      rules: module.rules().iter().map(detector_rule_snapshot).collect(),
    }
  }

  fn detector_rule_snapshot(rule: &StaticDetectorRule) -> DetectorRuleSnapshot {
    let spec = rule.spec();
    DetectorRuleSnapshot {
      id: format!("{:?}", spec.id()),
      stage: format!("{:?}", spec.diagnostic_stage()),
      inputs: spec
        .declared_inputs()
        .iter()
        .map(|input| format!("{input:?}"))
        .collect(),
      dependencies: spec
        .dependencies()
        .iter()
        .map(|dependency| format!("{dependency:?}"))
        .collect(),
      support_resources: spec
        .support_resources()
        .iter()
        .map(|resource| format!("{resource:?}"))
        .collect(),
      additive_scaling_domains: spec
        .additive_scaling_domains()
        .iter()
        .map(|input| format!("{input:?}"))
        .collect(),
    }
  }
}
