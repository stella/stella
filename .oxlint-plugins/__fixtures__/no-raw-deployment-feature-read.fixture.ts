// Passive regression fixture for
// `no-raw-deployment-feature-read/no-raw-deployment-feature-read`.

import { env as apiConfig } from "@/api/env";

declare const env: Record<string, boolean>;
declare const envDocumentProcessingWorker: Record<string, boolean>;
declare const isDeploymentFeatureEnabled: (flag: string) => boolean;
declare const process: { env: Record<string, string | undefined> };
declare const Bun: { env: Record<string, string | undefined> };

// MUST flag: a raw member read skips the owner's local-development policy.
// oxlint-disable-next-line no-raw-deployment-feature-read/no-raw-deployment-feature-read -- fixture: raw flag reads go through the owner
export const rawMember = env.FEATURE_LEGAL_LISTS;

// MUST flag: optional and computed spellings are the same read.
// oxlint-disable-next-line no-raw-deployment-feature-read/no-raw-deployment-feature-read, typescript/no-unnecessary-condition -- fixture: optional raw flag reads go through the owner
export const rawOptional = env?.FEATURE_PUBLIC_LAW;

// oxlint-disable-next-line no-raw-deployment-feature-read/no-raw-deployment-feature-read, typescript/dot-notation -- fixture: computed raw flag reads go through the owner
export const rawComputed = env["FEATURE_AI_MEMORY"];

// MUST flag: destructuring a flag from env is a raw read.
// oxlint-disable-next-line no-raw-deployment-feature-read/no-raw-deployment-feature-read -- fixture: destructured raw flag reads go through the owner
const { FEATURE_USAGE: destructured } = env;

// Allowed: the owner call.
// expect-clean: no-raw-deployment-feature-read/no-raw-deployment-feature-read
export const owned = isDeploymentFeatureEnabled("FEATURE_LEGAL_LISTS");

// Allowed: non-flag env keys.
// expect-clean: no-raw-deployment-feature-read/no-raw-deployment-feature-read
export const otherKey = env.ACTION_COST_RETENTION_DAYS;

// Allowed: a worker's own env schema is outside the API owner's reach.
// expect-clean: no-raw-deployment-feature-read/no-raw-deployment-feature-read
export const workerFlag = envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS;

void destructured;

// MUST flag: an aliased import of the API env is the same object.
// oxlint-disable-next-line no-raw-deployment-feature-read/no-raw-deployment-feature-read -- fixture: aliased env reads go through the owner
export const rawAliased = apiConfig.FEATURE_LEGAL_LISTS;

// MUST flag: the process environment skips the env schema and the owner.
// oxlint-disable-next-line no-raw-deployment-feature-read/no-raw-deployment-feature-read -- fixture: raw process-env flag reads go through the owner
export const rawProcess = process.env.FEATURE_LEGAL_LISTS;

// oxlint-disable-next-line no-raw-deployment-feature-read/no-raw-deployment-feature-read -- fixture: raw Bun env flag reads go through the owner
export const rawBun = Bun.env.FEATURE_USAGE;
