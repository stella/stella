import { DEFAULT_ENTITY_LABELS } from "./constants";
import type { PipelineConfig } from "./types";

export const DEFAULT_NATIVE_PIPELINE_CONFIG: PipelineConfig = {
  threshold: 0.3,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableLegalForms: true,
  enableNameCorpus: true,
  enableDenyList: true,
  enableGazetteer: false,
  enableCountries: true,
  enableConfidenceBoost: true,
  enableCoreference: true,
  enableHotwordRules: true,
  enableZoneClassification: true,
  standaloneStreetDetection: "off",
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "native-pipeline-default",
};
