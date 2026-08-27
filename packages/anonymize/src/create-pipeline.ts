import type { Dictionaries, PipelineConfig } from "./types";
import type { NativeAnonymizeBinding, PreparedNativePipeline } from "./native";
import { defaultDictionaryBundleOptions } from "./build-native-package";
import { createNativePipelineFromConfig } from "./native-pipeline";
import { DEFAULT_NATIVE_PIPELINE_CONFIG } from "./native-default-config";
import { applyPipelineLanguageScope } from "./language-scope";
import {
  pipelineLanguageSelectionKey,
  type NormalizedPipelineLanguageSelection,
} from "./pipeline-language";

type CreateSemanticPipelineOptions = {
  binding: NativeAnonymizeBinding;
  selection: NormalizedPipelineLanguageSelection;
};

type AnonymizeDataModule = {
  loadDictionaryBundle: (options?: {
    countries?: readonly string[];
    cityCountries?: readonly string[];
    nameLanguages?: readonly string[];
  }) => Promise<Dictionaries>;
};

const dictionaryCache = new Map<string, Promise<Dictionaries>>();
const semanticPipelineCache = new WeakMap<
  NativeAnonymizeBinding,
  Map<string, Promise<PreparedNativePipeline>>
>();
const MAX_SEMANTIC_PIPELINE_CACHE_ENTRIES = 8;

const getCachedEntry = <Value>(
  cache: Map<string, Value>,
  key: string,
): Value | undefined => {
  const cached = cache.get(key);
  if (cached === undefined) {
    return undefined;
  }
  cache.delete(key);
  cache.set(key, cached);
  return cached;
};

const setCachedEntry = <Value>(
  cache: Map<string, Value>,
  key: string,
  value: Value,
): void => {
  cache.set(key, value);
  if (cache.size <= MAX_SEMANTIC_PIPELINE_CACHE_ENTRIES) {
    return;
  }
  const oldestKey = cache.keys().next().value;
  if (oldestKey !== undefined) {
    cache.delete(oldestKey);
  }
};

const loadSemanticDictionaries = (
  key: string,
  config: PipelineConfig,
): Promise<Dictionaries> => {
  const cached = getCachedEntry(dictionaryCache, key);
  if (cached !== undefined) {
    return cached;
  }
  // Keep dictionary chunks out of the default-package import path. Bundlers
  // load only the chunks needed to assemble an unbundled semantic scope.
  let dictionaries: Promise<Dictionaries>;
  dictionaries = import("@stll/anonymize-data/cities")
    .then(({ loadDictionaryBundle }: AnonymizeDataModule) =>
      loadDictionaryBundle(defaultDictionaryBundleOptions(config)),
    )
    .catch((error: unknown) => {
      if (dictionaryCache.get(key) === dictionaries) {
        dictionaryCache.delete(key);
      }
      throw error;
    });
  setCachedEntry(dictionaryCache, key, dictionaries);
  return dictionaries;
};

const pipelineConfigFor = (
  selection: NormalizedPipelineLanguageSelection,
): PipelineConfig => {
  if (selection.type === "all") {
    return {
      ...DEFAULT_NATIVE_PIPELINE_CONFIG,
      labels: [...DEFAULT_NATIVE_PIPELINE_CONFIG.labels],
    };
  }
  const [language, ...languages] = selection.languages;
  return applyPipelineLanguageScope({
    ...DEFAULT_NATIVE_PIPELINE_CONFIG,
    labels: [...DEFAULT_NATIVE_PIPELINE_CONFIG.labels],
    workspaceId: `default-pipeline:${pipelineLanguageSelectionKey(selection)}`,
    ...(languages.length === 0
      ? { language }
      : { languages: [language, ...languages] }),
  });
};

const semanticPipelineCacheFor = (
  binding: NativeAnonymizeBinding,
): Map<string, Promise<PreparedNativePipeline>> => {
  const cached = semanticPipelineCache.get(binding);
  if (cached !== undefined) {
    return cached;
  }
  const created = new Map<string, Promise<PreparedNativePipeline>>();
  semanticPipelineCache.set(binding, created);
  return created;
};

export const createSemanticPipeline = ({
  binding,
  selection,
}: CreateSemanticPipelineOptions): Promise<PreparedNativePipeline> => {
  const key = pipelineLanguageSelectionKey(selection);
  const cache = semanticPipelineCacheFor(binding);
  const cached = getCachedEntry(cache, key);
  if (cached !== undefined) {
    return cached;
  }
  const config = pipelineConfigFor(selection);
  let pipeline: Promise<PreparedNativePipeline>;
  pipeline = loadSemanticDictionaries(key, config)
    .then((dictionaries) =>
      createNativePipelineFromConfig({
        binding,
        config: { ...config, dictionaries },
      }),
    )
    .catch((error: unknown) => {
      if (cache.get(key) === pipeline) {
        cache.delete(key);
      }
      throw error;
    });
  setCachedEntry(cache, key, pipeline);
  return pipeline;
};
