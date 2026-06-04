import { loadNameDictionaries } from "@stll/anonymize-data";
import {
  createPipelineContext,
  DEFAULT_OPERATOR_CONFIG,
  preparePipelineSearch,
  redactText,
  runPipeline,
} from "@stll/anonymize-wasm";
import type { PipelineContext } from "@stll/anonymize-wasm";

import { loadAnonymizationAllowlistCanonicals } from "@/api/lib/anonymization-allowlist";
import { loadAnonymizationGazetteerEntries } from "@/api/lib/anonymization-blacklist";
import type { AnonymizeTextFieldsInput } from "@/api/mcp/anonymization-core";
import { anonymizeTextFieldsWithDependencies } from "@/api/mcp/anonymization-core";

let dictionariesPromise: ReturnType<typeof loadNameDictionaries> | null = null;
let pipelineQueue: Promise<void> = Promise.resolve();

const pipelineContext: PipelineContext = createPipelineContext();

const getNameDictionaries = async () => {
  dictionariesPromise ??= loadNameDictionaries();
  return await dictionariesPromise;
};

const runWithPipelineContext = async <T>(
  task: () => Promise<T>,
): Promise<T> => {
  const run = pipelineQueue.then(task, task);
  pipelineQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return await run;
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

export const anonymizeTextFields = async (input: AnonymizeTextFieldsInput) => {
  if (input.context !== undefined) {
    return await anonymizeTextFieldsWithDependencies({
      ...input,
      dependencies: anonymizeTextFieldsDependencies,
    });
  }

  return await runWithPipelineContext(async () => {
    pipelineContext.corefSourceMap.clear();
    return await anonymizeTextFieldsWithDependencies({
      ...input,
      context: pipelineContext,
      dependencies: anonymizeTextFieldsDependencies,
    });
  });
};
