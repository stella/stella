import { loadNameDictionaries } from "@stll/anonymize-data";
import {
  createPipelineContext,
  DEFAULT_OPERATOR_CONFIG,
  preparePipelineSearch,
  redactText,
  runPipeline,
} from "@stll/anonymize-wasm";

import { loadAnonymizationAllowlistCanonicals } from "@/api/lib/anonymization-allowlist";
import { loadAnonymizationGazetteerEntries } from "@/api/lib/anonymization-blacklist";
import type { AnonymizeTextFieldsInput } from "@/api/mcp/anonymization-core";
import { anonymizeTextFieldsWithDependencies } from "@/api/mcp/anonymization-core";

let dictionariesPromise: ReturnType<typeof loadNameDictionaries> | null = null;

const getNameDictionaries = async () => {
  dictionariesPromise ??= loadNameDictionaries();
  return await dictionariesPromise;
};

const anonymizeTextFieldsDependencies = {
  createPipelineContext,
  defaultOperatorConfig: DEFAULT_OPERATOR_CONFIG,
  loadAnonymizationGazetteerEntries,
  loadAnonymizationAllowlistCanonicals,
  loadNameDictionaries: getNameDictionaries,
  preparePipelineSearch,
  redactText,
  runPipeline,
};

export const anonymizeTextFields = async (input: AnonymizeTextFieldsInput) =>
  await anonymizeTextFieldsWithDependencies({
    ...input,
    dependencies: anonymizeTextFieldsDependencies,
  });
