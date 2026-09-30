import { mockAnswersForOrganization } from "@/api/lib/tanstack-ai-models";

import { generateBatch } from "./generate-batch";

type BatchGenerator = typeof generateBatch;

let override: BatchGenerator | undefined;

/**
 * Swap in an alternate batch generator. Only the dev/test preload
 * (`src/dev/register-mock-ai.ts`) calls this, to wire the mock when
 * `USE_MOCK_AI` is set. Keeping the mock out of this production module is what
 * keeps mock generation out of the compiled
 * binary or the production dependency graph.
 */
export const registerBatchGenerator = (generator: BatchGenerator): void => {
  override = generator;
};

/**
 * The generator for one batch. The mock answers only where the chat mock
 * would (`mockAnswersRequest`): an organization that configured its own key
 * gets its real provider, unless `USE_MOCK_AI` is `"force"`.
 */
export const getBatchGenerator =
  (): BatchGenerator =>
  async (...args) => {
    const [options] = args;
    const generator =
      override !== undefined && mockAnswersForOrganization(options.orgAIConfig)
        ? override
        : generateBatch;
    return await generator(...args);
  };
