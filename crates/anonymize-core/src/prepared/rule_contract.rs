/// Static metadata for one prepared rule.
///
/// The generic types keep the substrate independent from any particular rule
/// family. Concrete rule systems provide closed identifier, input, resource,
/// and stage types at compile time.
#[derive(Clone, Copy)]
pub(super) struct RuleSpec<
  Id: 'static,
  Input: 'static,
  Resource: 'static,
  Stage,
> {
  id: Id,
  stage: Stage,
  declared_inputs: &'static [Input],
  dependencies: &'static [Id],
  support_resources: &'static [Resource],
  additive_scaling_domains: &'static [Input],
}

impl<Id: Copy + 'static, Input: 'static, Resource: 'static, Stage: Copy>
  RuleSpec<Id, Input, Resource, Stage>
{
  pub(super) const fn define(id: Id, stage: Stage) -> Self {
    Self {
      id,
      stage,
      declared_inputs: &[],
      dependencies: &[],
      support_resources: &[],
      additive_scaling_domains: &[],
    }
  }

  pub(super) const fn requires(
    mut self,
    declared_inputs: &'static [Input],
  ) -> Self {
    self.declared_inputs = declared_inputs;
    self
  }

  pub(super) const fn after(mut self, dependencies: &'static [Id]) -> Self {
    self.dependencies = dependencies;
    self
  }

  pub(super) const fn uses(
    mut self,
    support_resources: &'static [Resource],
  ) -> Self {
    self.support_resources = support_resources;
    self
  }

  pub(super) const fn scales_additively_in(
    mut self,
    domains: &'static [Input],
  ) -> Self {
    self.additive_scaling_domains = domains;
    self
  }

  pub(super) const fn id(self) -> Id {
    self.id
  }

  pub(super) const fn stage(self) -> Stage {
    self.stage
  }

  pub(super) const fn declared_inputs(self) -> &'static [Input] {
    self.declared_inputs
  }

  pub(super) const fn dependencies(self) -> &'static [Id] {
    self.dependencies
  }

  pub(super) const fn support_resources(self) -> &'static [Resource] {
    self.support_resources
  }

  pub(super) const fn additive_scaling_domains(self) -> &'static [Input] {
    self.additive_scaling_domains
  }
}

/// A named, statically linked collection of rules.
#[derive(Clone, Copy)]
pub(super) struct RulePack<Rule: 'static> {
  name: &'static str,
  rules: &'static [Rule],
}

impl<Rule: 'static> RulePack<Rule> {
  pub(super) const fn declare(
    name: &'static str,
    rules: &'static [Rule],
  ) -> Self {
    Self { name, rules }
  }

  pub(super) const fn name(self) -> &'static str {
    self.name
  }

  pub(super) const fn rules(self) -> &'static [Rule] {
    self.rules
  }

  pub(super) const fn is_empty(&self) -> bool {
    self.rules.is_empty()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[derive(Clone, Copy, Debug, Eq, PartialEq)]
  enum TestId {
    Alpha,
  }

  #[derive(Clone, Copy, Debug, Eq, PartialEq)]
  enum TestInput {
    Text,
  }

  #[derive(Clone, Copy, Debug, Eq, PartialEq)]
  enum TestResource {
    Vocabulary,
  }

  #[derive(Clone, Copy, Debug, Eq, PartialEq)]
  enum TestStage {
    Find,
  }

  const SPEC: RuleSpec<TestId, TestInput, TestResource, TestStage> =
    RuleSpec::define(TestId::Alpha, TestStage::Find)
      .requires(&[TestInput::Text])
      .uses(&[TestResource::Vocabulary])
      .scales_additively_in(&[TestInput::Text]);
  const PACK: RulePack<RuleSpec<TestId, TestInput, TestResource, TestStage>> =
    RulePack::declare("test", &[SPEC]);

  #[test]
  fn static_rule_pack_retains_its_contract() {
    assert_eq!(PACK.name(), "test");
    assert_eq!(PACK.rules().len(), 1);
    assert_eq!(SPEC.id(), TestId::Alpha);
    assert_eq!(SPEC.stage(), TestStage::Find);
    assert_eq!(SPEC.declared_inputs(), &[TestInput::Text]);
    assert!(SPEC.dependencies().is_empty());
    assert_eq!(SPEC.support_resources(), &[TestResource::Vocabulary]);
    assert_eq!(SPEC.additive_scaling_domains(), &[TestInput::Text]);
  }
}
