#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_NATIVE_PIPELINE_CONFIG,
  prepareNativePipelinePackage,
  SUPPORTED_LANGUAGES,
} from "../dist/index.mjs";
import {
  applyPipelineLanguageScope,
  defaultDictionaryBundleOptions,
} from "../dist/build-native-package.mjs";
import { loadNativeAnonymizeBinding } from "../dist/native-node.mjs";

const args = parseArgs(process.argv.slice(2));
const outputPath = resolve(args.out ?? "native-pipeline.stlanonpkg");
const compressed = args.compressed === true;
const { config, gazetteerEntries } = await loadPackageInput(args);
const binding = loadNativeAnonymizeBinding();
const packageBytes = await prepareNativePipelinePackage({
  binding,
  config,
  gazetteerEntries,
  compressed,
});

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, packageBytes);

console.log(
  JSON.stringify({
    event: "native-pipeline-package",
    outputPath,
    bytes: packageBytes.byteLength,
    compressed,
    nativeVersion: binding.nativePackageVersion(),
  }),
);

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    switch (value) {
      case "--config": {
        result.config = requiredValue(values, index, value);
        index += 1;
        break;
      }
      case "--export": {
        result.exportName = requiredValue(values, index, value);
        index += 1;
        break;
      }
      case "--out": {
        result.out = requiredValue(values, index, value);
        index += 1;
        break;
      }
      case "--raw": {
        result.raw = true;
        break;
      }
      case "--compressed": {
        result.compressed = true;
        break;
      }
      case "--default-dictionaries": {
        result.defaultDictionaries = true;
        break;
      }
      case "--language": {
        result.language = requiredValue(values, index, value);
        index += 1;
        break;
      }
      case "--languages": {
        result.languages = requiredValue(values, index, value);
        index += 1;
        break;
      }
      case "--help": {
        printHelp();
        process.exit(0);
      }
      default:
        throw new Error(`Unknown option: ${value}`);
    }
  }
  if (result.raw && result.compressed) {
    throw new Error("Use either --raw or --compressed, not both");
  }
  return result;
}

function requiredValue(values, index, option) {
  const value = values[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

async function loadPackageInput(options) {
  const input = await loadBasePackageInput(options);
  const scopedConfig = applyPipelineLanguageScope(
    applyCliLanguageScope(input.config, options),
  );
  const withDictionaries =
    !options.defaultDictionaries || scopedConfig.dictionaries !== undefined
      ? { ...input, config: scopedConfig }
      : {
          ...input,
          config: {
            ...scopedConfig,
            dictionaries: await loadDefaultDictionaries(scopedConfig),
          },
        };
  return withDictionaries;
}

async function loadBasePackageInput(options) {
  if (!options.config) {
    return { config: defaultNativePipelineConfig(), gazetteerEntries: [] };
  }
  const moduleUrl = pathToFileURL(resolve(options.config)).href;
  // eslint-disable-next-line stll/no-dynamic-import-specifier
  const loaded = await import(moduleUrl);
  const exportName = options.exportName ?? "default";
  const candidate =
    exportName === "default" ? loaded.default : loaded[exportName];
  if (candidate === undefined) {
    throw new Error(`Config module does not export ${exportName}`);
  }
  const value =
    typeof candidate === "function" ? await candidate() : await candidate;
  if (!value || typeof value !== "object") {
    throw new TypeError("Native package config export must be an object");
  }
  if ("config" in value) {
    return {
      config: value.config,
      gazetteerEntries: value.gazetteerEntries ?? [],
    };
  }
  return { config: value, gazetteerEntries: [] };
}

function defaultNativePipelineConfig() {
  return {
    ...DEFAULT_NATIVE_PIPELINE_CONFIG,
    labels: [...DEFAULT_NATIVE_PIPELINE_CONFIG.labels],
    workspaceId: "native-pipeline-package",
  };
}

function applyCliLanguageScope(pipelineConfig, options) {
  if (options.language !== undefined && options.languages !== undefined) {
    throw new Error("Use either --language or --languages, not both");
  }
  if (options.language !== undefined) {
    const language = normalizeLanguageOption(options.language, "--language");
    return { ...pipelineConfig, language, languages: undefined };
  }
  if (options.languages === undefined) {
    return pipelineConfig;
  }
  const languages = normalizeLanguageList(options.languages);
  return { ...pipelineConfig, language: undefined, languages };
}

function normalizeLanguageOption(value, option) {
  const language = value.trim().toLowerCase();
  if (language.length === 0) {
    throw new Error(`${option} requires a non-empty language code`);
  }
  if (!SUPPORTED_LANGUAGES.includes(language)) {
    throw new Error(
      `Unsupported pipeline language ${JSON.stringify(value)}; expected one of: ${SUPPORTED_LANGUAGES.join(", ")}`,
    );
  }
  return language;
}

function normalizeLanguageList(value) {
  const languages = value
    .split(",")
    .map((entry) => normalizeLanguageOption(entry, "--languages"))
    .filter((entry, index, entries) => entries.indexOf(entry) === index);
  if (languages.length === 0) {
    throw new Error("--languages requires at least one language code");
  }
  return languages;
}

async function loadDefaultDictionaries(pipelineConfig) {
  let loaded;
  try {
    // The bundle loads city dictionaries, so it ships in the data package's
    // cities entry, not its root: the root entry stays free of the city
    // loader map so bundled consumers do not carry every city chunk.
    // The specifier stays literal for stll/no-dynamic-import-specifier.
    loaded = await import("@stll/anonymize-data/cities");
  } catch (error) {
    throw new Error(
      `--default-dictionaries requires @stll/anonymize-data: ${formatError(error)}`,
    );
  }
  if (typeof loaded.loadDictionaryBundle !== "function") {
    throw new TypeError(
      "@stll/anonymize-data/cities does not export loadDictionaryBundle",
    );
  }
  return loaded.loadDictionaryBundle(
    defaultDictionaryBundleOptions(pipelineConfig),
  );
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function printHelp() {
  console.log(`Usage: build-native-pipeline-package [options]

Options:
  --out <path>              Output package path. Defaults to native-pipeline.stlanonpkg.
  --config <path>           ESM module exporting a PipelineConfig or { config, gazetteerEntries }.
  --export <name>           Export name to read from the config module. Defaults to default.
  --language <code>         Build a package scoped to one content language.
  --languages <codes>       Build a package scoped to comma-separated content languages.
  --default-dictionaries    Load @stll/anonymize-data into configs that do not provide dictionaries.
  --compressed              Write an LZ4-compressed package.
  --raw                     Write an uncompressed package. This is the default.
`);
}
