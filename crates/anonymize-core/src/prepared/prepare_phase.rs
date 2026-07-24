use std::time::Instant;

use crate::dates::{DateData, PreparedDateData};
use crate::diagnostics::{DiagnosticStage, StaticRedactionDiagnostics};
use crate::money::{MonetaryData, PreparedMonetaryData};
use crate::types::{Error, Result};

use super::artifacts::{PreparedEngineArtifacts, PreparedEngineArtifactsView};
use super::config_validation::validate_supported_config_for_artifacts;
use super::engine_state::{
  PipelinePolicy, PreparedAnchoredData, PreparedStaticData, SearchIndexes,
};
use super::index_prepare::{
  PreparedEngineIndexBundle, SearchIndexConfigInput, prepare_search_artifacts,
  prepare_search_index_bundle,
};
use super::results::PreparedEngineBuildResult;
use super::support_prepare::{
  PreparedSupportData, prepare_support_data, take_support_input,
};
use super::timing::elapsed_us;
use super::{
  PreparedEngine, PreparedEngineConfig, PreparedEngineDetectorConfig,
  PreparedEnginePolicyConfig, PreparedEngineSearchConfig, PreparedEngineSlices,
};

#[bon::bon]
impl PreparedEngine {
  #[builder]
  pub fn prepare(
    config: PreparedEngineConfig,
    artifacts: Option<&PreparedEngineArtifactsView<'_>>,
  ) -> Result<Self> {
    Self::new_inner(config, None, artifacts)
  }

  #[builder]
  pub fn prepare_with_diagnostics(
    config: PreparedEngineConfig,
    artifacts: Option<&PreparedEngineArtifactsView<'_>>,
  ) -> Result<PreparedEngineBuildResult> {
    let mut diagnostics = StaticRedactionDiagnostics::default();
    let prepared = Self::new_inner(config, Some(&mut diagnostics), artifacts)?;

    Ok(PreparedEngineBuildResult {
      prepared,
      diagnostics,
    })
  }

  pub fn new(config: PreparedEngineConfig) -> Result<Self> {
    Self::prepare().config(config).call()
  }

  pub fn warm_lazy_regex(&self) -> Result<()> {
    self.warm_lazy_regex_inner(None)
  }

  pub fn warm_lazy_regex_diagnostics(
    &self,
  ) -> Result<StaticRedactionDiagnostics> {
    let mut diagnostics = StaticRedactionDiagnostics::default();
    self.warm_lazy_regex_inner(Some(&mut diagnostics))?;
    Ok(diagnostics)
  }

  fn warm_lazy_regex_inner(
    &self,
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
  ) -> Result<()> {
    let total_start = Instant::now();
    let stages = [
      (DiagnosticStage::WarmRegex, &self.indexes.regex),
      (DiagnosticStage::WarmCustomRegex, &self.indexes.custom_regex),
      (
        DiagnosticStage::WarmLegalFormSearch,
        &self.indexes.legal_forms,
      ),
      (DiagnosticStage::WarmTriggerSearch, &self.indexes.triggers),
      (DiagnosticStage::WarmLiteral, &self.indexes.literals),
    ];
    let metrics = warm_search_indexes(&stages)?;
    let count = metrics
      .iter()
      .map(|metric| metric.count)
      .fold(0usize, usize::saturating_add);
    if let Some(diagnostics) = &mut diagnostics {
      for metric in metrics {
        diagnostics.record_stage(
          metric.stage,
          Some(metric.count),
          Some(metric.elapsed_us),
          None,
        );
      }
      diagnostics.record_stage(
        DiagnosticStage::WarmTotal,
        Some(count),
        Some(elapsed_us(total_start)),
        None,
      );
    }
    Ok(())
  }

  pub fn prepare_artifacts(
    config: PreparedEngineConfig,
  ) -> Result<PreparedEngineArtifacts> {
    prepare_search_artifacts(config)
  }

  pub fn new_with_artifacts(
    config: PreparedEngineConfig,
    artifacts: &PreparedEngineArtifacts,
  ) -> Result<Self> {
    let artifacts = artifacts.as_view();
    Self::new_with_artifact_view(config, &artifacts)
  }

  pub fn new_with_artifact_view(
    config: PreparedEngineConfig,
    artifacts: &PreparedEngineArtifactsView<'_>,
  ) -> Result<Self> {
    Self::new_inner(config, None, Some(artifacts))
  }

  pub fn new_with_artifacts_diagnostics(
    config: PreparedEngineConfig,
    artifacts: &PreparedEngineArtifacts,
  ) -> Result<PreparedEngineBuildResult> {
    let artifacts = artifacts.as_view();
    Self::new_with_artifact_view_diagnostics(config, &artifacts)
  }

  pub fn new_with_artifact_view_diagnostics(
    config: PreparedEngineConfig,
    artifacts: &PreparedEngineArtifactsView<'_>,
  ) -> Result<PreparedEngineBuildResult> {
    Self::prepare_with_diagnostics()
      .config(config)
      .artifacts(artifacts)
      .call()
  }

  pub fn new_with_diagnostics(
    config: PreparedEngineConfig,
  ) -> Result<PreparedEngineBuildResult> {
    Self::prepare_with_diagnostics().config(config).call()
  }

  fn new_inner(
    mut config: PreparedEngineConfig,
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
    artifacts: Option<&PreparedEngineArtifactsView<'_>>,
  ) -> Result<Self> {
    let total_start = Instant::now();
    validate_supported_config_for_artifacts(&config, artifacts)?;
    let monetary_extraction = should_extract_monetary_data(&config.search);
    let support_input = take_support_input(&mut config.detectors);
    let PreparedEngineConfig {
      search,
      policy: policy_config,
      mut detectors,
    } = config;
    let PreparedEngineSearchConfig {
      regex_patterns,
      custom_regex_patterns,
      literal_patterns,
      regex_options,
      custom_regex_options,
      literal_options,
      slices,
      regex_meta,
      custom_regex_meta,
    } = search;
    let PreparedEnginePolicyConfig {
      allowed_labels,
      threshold,
      confidence_boost,
    } = policy_config;
    let anchored_len = anchored_config_len(
      detectors.date_data.as_ref(),
      detectors.monetary_data.as_ref(),
    );
    let date_data_input = detectors.date_data.as_ref();
    let monetary_data_input = detectors.monetary_data.take();
    let search_input = SearchIndexConfigInput {
      regex_patterns,
      custom_regex_patterns,
      literal_patterns,
      regex_options,
      custom_regex_options,
      literal_options,
      anchored_len,
    };
    let collect_diagnostics = diagnostics.is_some();
    let PreparedEnginePrepareBranches {
      anchored,
      index_bundle,
      support_data,
      diagnostics: branch_diagnostics,
    } = prepare_engine_branches(PrepareEngineBranchInput {
      date_data: date_data_input,
      monetary_data: monetary_data_input,
      monetary_extraction,
      search: search_input,
      support: support_input,
      slices: &slices,
      artifacts,
      collect_diagnostics,
    })?;
    append_prepare_branch_diagnostics(&mut diagnostics, branch_diagnostics);
    let PreparedEngineIndexBundle {
      regex,
      custom_regex,
      legal_forms,
      triggers,
      literals,
      counts,
    } = index_bundle;
    record_prepare_total(
      &mut diagnostics,
      counts.total().saturating_add(support_data.count),
      total_start,
    );
    let indexes = SearchIndexes {
      regex,
      custom_regex,
      legal_forms,
      triggers,
      literals,
    };
    let policy = PipelinePolicy {
      allowed_labels,
      threshold,
      confidence_boost,
      slices,
      regex_meta,
      custom_regex_meta,
    };
    let data = prepared_static_data(detectors, support_data, anchored);
    Ok(Self {
      indexes,
      policy,
      data,
    })
  }
}

struct PrepareBranch<T> {
  value: T,
  diagnostics: Option<StaticRedactionDiagnostics>,
}

struct PrepareBranchDiagnostics {
  anchored: Option<StaticRedactionDiagnostics>,
  indexes: Option<StaticRedactionDiagnostics>,
  support: Option<StaticRedactionDiagnostics>,
}

struct PrepareEngineBranchInput<'a> {
  date_data: Option<&'a DateData>,
  monetary_data: Option<MonetaryData>,
  monetary_extraction: bool,
  search: SearchIndexConfigInput,
  support: super::support_prepare::SupportDataInput,
  slices: &'a PreparedEngineSlices,
  artifacts: Option<&'a PreparedEngineArtifactsView<'a>>,
  collect_diagnostics: bool,
}

struct PreparedEnginePrepareBranches {
  anchored: PreparedAnchoredData,
  index_bundle: PreparedEngineIndexBundle,
  support_data: PreparedSupportData,
  diagnostics: PrepareBranchDiagnostics,
}

fn prepare_engine_branches(
  input: PrepareEngineBranchInput<'_>,
) -> Result<PreparedEnginePrepareBranches> {
  let PrepareEngineBranchInput {
    date_data,
    monetary_data,
    monetary_extraction,
    search,
    support,
    slices,
    artifacts,
    collect_diagnostics,
  } = input;

  crate::exec::scope(|scope| {
    let anchored = scope.spawn(move || {
      prepare_anchored_branch(
        date_data,
        monetary_data,
        monetary_extraction,
        search.anchored_len,
        collect_diagnostics,
      )
    });
    let indexes = scope.spawn(move || {
      prepare_index_branch(search, slices, artifacts, collect_diagnostics)
    });
    let support_data =
      scope.spawn(move || prepare_support_branch(support, collect_diagnostics));

    let anchored = join_prepare_branch(anchored, "anchored_data")?;
    let indexes = join_prepare_branch(indexes, "search_indexes")?;
    let support_data = join_prepare_branch(support_data, "support_data")?;

    Ok(PreparedEnginePrepareBranches {
      anchored: anchored.value,
      index_bundle: indexes.value,
      support_data: support_data.value,
      diagnostics: PrepareBranchDiagnostics {
        anchored: anchored.diagnostics,
        indexes: indexes.diagnostics,
        support: support_data.diagnostics,
      },
    })
  })
}

fn prepare_anchored_branch(
  date_data: Option<&DateData>,
  monetary_data: Option<MonetaryData>,
  monetary_extraction: bool,
  anchored_len: usize,
  collect_diagnostics: bool,
) -> Result<PrepareBranch<PreparedAnchoredData>> {
  let mut diagnostics = branch_diagnostics(collect_diagnostics);
  let value = prepare_anchored_data(
    date_data,
    monetary_data,
    monetary_extraction,
    anchored_len,
    diagnostics.as_mut(),
  )?;
  Ok(PrepareBranch { value, diagnostics })
}

fn prepare_index_branch(
  search: SearchIndexConfigInput,
  slices: &PreparedEngineSlices,
  artifacts: Option<&PreparedEngineArtifactsView<'_>>,
  collect_diagnostics: bool,
) -> Result<PrepareBranch<PreparedEngineIndexBundle>> {
  let mut diagnostics = branch_diagnostics(collect_diagnostics);
  let value = {
    let mut diagnostics_ref = diagnostics.as_mut();
    prepare_search_index_bundle(
      search,
      slices,
      artifacts,
      &mut diagnostics_ref,
    )?
  };
  Ok(PrepareBranch { value, diagnostics })
}

fn prepare_support_branch(
  support: super::support_prepare::SupportDataInput,
  collect_diagnostics: bool,
) -> Result<PrepareBranch<PreparedSupportData>> {
  let mut diagnostics = branch_diagnostics(collect_diagnostics);
  let value = {
    let mut diagnostics_ref = diagnostics.as_mut();
    prepare_support_data(support, &mut diagnostics_ref)?
  };
  Ok(PrepareBranch { value, diagnostics })
}

fn join_prepare_branch<T>(
  handle: crate::exec::JoinHandle<'_, Result<PrepareBranch<T>>>,
  field: &'static str,
) -> Result<PrepareBranch<T>> {
  handle.join().map_err(|_| Error::InvalidStaticData {
    field,
    reason: "prepare branch panicked".to_owned(),
  })?
}

fn branch_diagnostics(collect: bool) -> Option<StaticRedactionDiagnostics> {
  collect.then(StaticRedactionDiagnostics::default)
}

fn append_prepare_branch_diagnostics(
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
  branch: PrepareBranchDiagnostics,
) {
  let Some(diagnostics) = diagnostics else {
    return;
  };
  if let Some(anchored) = branch.anchored {
    diagnostics.extend(anchored);
  }
  if let Some(indexes) = branch.indexes {
    diagnostics.extend(indexes);
  }
  if let Some(support) = branch.support {
    diagnostics.extend(support);
  }
}

struct WarmSearchMetric {
  stage: DiagnosticStage,
  count: usize,
  elapsed_us: u64,
}

fn warm_search_indexes(
  stages: &[(DiagnosticStage, &crate::search::SearchIndex); 5],
) -> Result<Vec<WarmSearchMetric>> {
  crate::exec::scope(|scope| {
    let mut handles = Vec::with_capacity(stages.len());
    for (stage, index) in stages.iter().copied() {
      handles.push(scope.spawn(move || warm_search_index(stage, index)));
    }

    let mut metrics = Vec::with_capacity(handles.len());
    for handle in handles {
      metrics.push(handle.join().map_err(|_| Error::InvalidStaticData {
        field: "search_index_warmup",
        reason: "search index warm-up panicked".to_owned(),
      })??);
    }
    Ok(metrics)
  })
}

fn warm_search_index(
  stage: DiagnosticStage,
  index: &crate::search::SearchIndex,
) -> Result<WarmSearchMetric> {
  let start = Instant::now();
  index.warm_lazy_regex()?;
  Ok(WarmSearchMetric {
    stage,
    count: index.len(),
    elapsed_us: elapsed_us(start),
  })
}

fn prepared_static_data(
  detectors: PreparedEngineDetectorConfig,
  support_data: PreparedSupportData,
  anchored: PreparedAnchoredData,
) -> PreparedStaticData {
  PreparedStaticData {
    deny_list: detectors.deny_list_data,
    false_positive_filters: detectors.false_positive_filters,
    gazetteer: detectors.gazetteer_data,
    countries: detectors.country_data,
    hotwords: support_data.hotwords,
    triggers: support_data.triggers,
    legal_forms: support_data.legal_forms,
    address_seed: support_data.address_seed,
    zones: support_data.zones,
    address_context: support_data.address_context,
    coreference: support_data.coreference,
    name_corpus: support_data.names,
    signatures: support_data.signature,
    anchored,
  }
}

fn should_extract_monetary_data(config: &PreparedEngineSearchConfig) -> bool {
  config.regex_patterns.is_empty()
    || config
      .regex_meta
      .iter()
      .any(|meta| meta.label == crate::labels::MONETARY_AMOUNT_LABEL)
}

fn record_prepare_total(
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
  count: usize,
  start: Instant,
) {
  let Some(diagnostics) = diagnostics else {
    return;
  };
  diagnostics.record_stage(
    DiagnosticStage::PrepareTotal,
    Some(count),
    Some(elapsed_us(start)),
    None,
  );
}

fn anchored_config_len(
  date_data: Option<&DateData>,
  monetary_data: Option<&MonetaryData>,
) -> usize {
  let date_len = date_data.map_or(0, |data| {
    data.month_names_by_language.values().map(Vec::len).sum()
  });
  let monetary_len = monetary_data.map_or(0, |data| {
    data
      .currencies
      .codes
      .len()
      .saturating_add(data.currencies.symbols.len())
      .saturating_add(data.currencies.local_names.len())
  });
  date_len.saturating_add(monetary_len)
}

fn prepare_anchored_data(
  date_data: Option<&DateData>,
  monetary_data: Option<MonetaryData>,
  monetary_extraction: bool,
  anchored_len: usize,
  diagnostics: Option<&mut StaticRedactionDiagnostics>,
) -> Result<PreparedAnchoredData> {
  let anchored_start = Instant::now();
  let prepared_date = date_data.and_then(PreparedDateData::new);
  let prepared_monetary = monetary_data.and_then(PreparedMonetaryData::new);

  if let Some(diagnostics) = diagnostics {
    diagnostics.record_stage(
      DiagnosticStage::PrepareAnchored,
      Some(anchored_len),
      Some(elapsed_us(anchored_start)),
      None,
    );
  }

  PreparedAnchoredData::new(
    prepared_date,
    prepared_monetary,
    monetary_extraction,
  )
}
