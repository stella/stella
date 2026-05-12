import { loadNameDictionaries } from "@stll/anonymize-data";
import {
  createPipelineContext,
  DEFAULT_OPERATOR_CONFIG,
  redactText,
  runPipeline,
} from "@stll/anonymize-wasm";

import { loadAnonymizationGazetteerEntries } from "@/api/lib/anonymization-blacklist";
import type { AnonymizeTextFieldsInput } from "@/api/mcp/anonymization-core";
import { anonymizeTextFieldsWithDependencies } from "@/api/mcp/anonymization-core";

const anonymizeTextFieldsDependencies = {
  createPipelineContext,
  defaultOperatorConfig: DEFAULT_OPERATOR_CONFIG,
  loadAnonymizationGazetteerEntries,
  loadNameDictionaries,
  redactText,
  runPipeline,
};

export const anonymizeTextFields = async (input: AnonymizeTextFieldsInput) =>
  await anonymizeTextFieldsWithDependencies({
    ...input,
    dependencies: anonymizeTextFieldsDependencies,
  });
