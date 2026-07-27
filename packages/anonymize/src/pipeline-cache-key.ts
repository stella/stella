import {
  isLegalFormsEnabled,
  type GazetteerEntry,
  type PipelineConfig,
} from "./types";
import { languageSelectionKey } from "./util/language-selection";

const DEFAULT_CUSTOM_REGEX_SCORE = 0.9;

const contentLanguageFingerprint = (
  config: Pick<PipelineConfig, "language" | "languages">,
): string => {
  const languages =
    config.languages ??
    (config.language === undefined ? [] : [config.language]);
  return languageSelectionKey(languages);
};

export const pipelineConfigKey = (
  config: PipelineConfig,
  gazetteerEntries: readonly GazetteerEntry[],
): string => {
  const legalFormsEnabled = isLegalFormsEnabled(config);
  const customDenyFingerprint =
    config.enableDenyList && config.customDenyList
      ? config.customDenyList
          .map((entry) =>
            JSON.stringify({
              label: entry.label,
              value: entry.value,
              variants: [...(entry.variants ?? [])].sort(),
            }),
          )
          .sort()
          .join("\n")
      : "";
  const customRegexFingerprint =
    config.enableRegex && config.customRegexes
      ? config.customRegexes
          .map((entry) =>
            JSON.stringify({
              label: entry.label,
              pattern: entry.pattern,
              preparedArtifactPolicy: entry.preparedArtifactPolicy ?? null,
              score: entry.score ?? DEFAULT_CUSTOM_REGEX_SCORE,
            }),
          )
          .sort()
          .join("\n")
      : "";
  const gazFingerprint =
    config.enableGazetteer && gazetteerEntries.length > 0
      ? gazetteerEntries
          .map(
            (entry) =>
              `${entry.id}:${entry.canonical}:${entry.label}:${[
                ...entry.variants,
              ]
                .sort()
                .join(",")}`,
          )
          .toSorted()
          .join(";")
      : "";

  return (
    `${config.enableDenyList}:` +
    `${config.enableTriggerPhrases}:` +
    `${legalFormsEnabled}:` +
    `${config.enableNameCorpus}:` +
    `${contentLanguageFingerprint(config)}:` +
    `${config.nameCorpusLanguages?.toSorted().join(",") ?? ""}:` +
    `${config.enableRegex}:` +
    `${config.threshold}:` +
    `${config.enableConfidenceBoost}:` +
    `${config.enableHotwordRules === true}:` +
    `${config.enableCoreference === true}:` +
    `${config.enableZoneClassification === true}:` +
    `${config.labels.toSorted().join(",")}:` +
    `${config.denyListCountries?.toSorted().join(",") ?? ""}:` +
    `${config.denyListRegions?.toSorted().join(",") ?? ""}:` +
    `${config.denyListExcludeCategories?.toSorted().join(",") ?? ""}:` +
    `${customDenyFingerprint}:` +
    `${customRegexFingerprint}:` +
    `${config.enableGazetteer}:${gazFingerprint}:` +
    `${config.enableCountries !== false}:` +
    `${config.standaloneStreetDetection ?? "off"}`
  );
};
