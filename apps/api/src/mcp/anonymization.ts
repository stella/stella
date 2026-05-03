import { loadNameDictionaries } from "@stll/anonymize-data";
import {
  createPipelineContext,
  redactText,
  runPipeline,
} from "@stll/anonymize-wasm";

import { loadAnonymizationGazetteerEntries } from "@/api/lib/anonymization-blacklist";
import type { AnonymizeTextFieldsInput } from "@/api/mcp/anonymization-core";
import { anonymizeTextFieldsWithDependencies } from "@/api/mcp/anonymization-core";

const anonymizeTextFieldsDependencies = {
  createPipelineContext,
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
