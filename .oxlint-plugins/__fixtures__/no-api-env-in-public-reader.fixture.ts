// Passive regression fixture for no-api-env-in-public-reader.

// expect-clean: no-api-env-in-public-reader/no-api-env-in-public-reader
import type { env as apiEnv } from "@/api/env";
// expect-clean: no-api-env-in-public-reader/no-api-env-in-public-reader
import { envPublicCorpus } from "@/api/env-public-corpus";
// oxlint-disable-next-line no-api-env-in-public-reader/no-api-env-in-public-reader -- fixture: the reader cannot load the full API environment
import { env } from "@/api/env";

export const settings: Pick<typeof apiEnv, "PUBLIC_LAW_DATABASE_POOL_MAX"> =
  envPublicCorpus;
export const frontendUrl = env.FRONTEND_URL;

export const lazyWorkerEnvironment = async () =>
  // oxlint-disable-next-line no-api-env-in-public-reader/no-api-env-in-public-reader -- fixture: a lazy load evaluates the same environment
  await import("@/api/env-document-processing-worker");
