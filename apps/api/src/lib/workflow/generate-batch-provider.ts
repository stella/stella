import { generateBatch } from "./generate-batch";

type BatchGenerator = typeof generateBatch;

let override: BatchGenerator | undefined;

/**
 * Swap in an alternate batch generator. Only the dev/test preload
 * (`src/dev/register-mock-ai.ts`) calls this, to wire the faker-backed mock when
 * `USE_MOCK_AI` is set. Keeping the mock out of this production module is what
 * lets `@faker-js/faker` stay a devDependency and never enter the compiled
 * binary or the production dependency graph.
 */
export const registerBatchGenerator = (generator: BatchGenerator): void => {
  override = generator;
};

export const getBatchGenerator = (): BatchGenerator =>
  override ?? generateBatch;
