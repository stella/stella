import { panic, Result } from "better-result";
import * as v from "valibot";

import { ParameterStoreError, readParameter } from "@stll/parameter-store";

import { envBase } from "@/api/env-base";
import type { DeploymentFeatureFlag } from "@/api/lib/deployment-feature";
import type { FeatureAccessGrants } from "@/api/lib/feature-access/grants-schema";
import { featureAccessGrantsEnvSchema } from "@/api/lib/feature-access/grants-schema";
import { startNonOverlappingInterval } from "@/api/lib/non-overlapping-interval";
import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { withTimeout } from "@/api/lib/with-timeout";
import { isLocalDevOpen, isLocalTestRun } from "@/api/runtime-mode";

/** Metadata polling bounds grant propagation without adding work to requests. */
const FEATURE_ACCESS_REFRESH_INTERVAL_MS = 60_000;
const FEATURE_ACCESS_REFRESH_TIMEOUT_MS = 5000;
const FEATURE_ACCESS_REFRESH_FAILED_SINK = failureSink({
  event: "feature_access.refresh_failed",
  expected: [],
});

export type FeatureAccessGrantsState = Readonly<{
  grants: FeatureAccessGrants;
  /** Null only when grants came from the process environment rather than SSM. */
  version: number | null;
}>;

type FeatureAccessGrantSource = {
  readValue: (signal: AbortSignal) => Promise<{ raw: string; version: number }>;
  readVersion: (signal: AbortSignal) => Promise<number>;
};

type CreateFeatureAccessGrantsOwnerOptions = {
  initial: FeatureAccessGrantsState;
  onRefreshFailure: (error: unknown) => void;
  source: FeatureAccessGrantSource;
};

const isNewerParameterVersion = (
  candidate: number,
  committed: number | null,
): boolean => committed === null || candidate > committed;

export const createFeatureAccessGrantsOwner = ({
  initial,
  onRefreshFailure,
  source,
}: CreateFeatureAccessGrantsOwnerOptions) => {
  let current = initial;
  let failureReported = false;

  const read = (): FeatureAccessGrantsState => current;
  const refresh = async (): Promise<void> => {
    const refreshed = await Result.tryPromise({
      try: async () =>
        withTimeout(
          async (signal) => {
            const version = await source.readVersion(signal);
            if (!isNewerParameterVersion(version, current.version)) {
              return null;
            }
            const loaded = await source.readValue(signal);
            if (!isNewerParameterVersion(loaded.version, current.version)) {
              return null;
            }
            return {
              parsed: v.parse(featureAccessGrantsEnvSchema, loaded.raw),
              version: loaded.version,
            };
          },
          {
            label: "feature_access.refresh",
            timeoutMs: FEATURE_ACCESS_REFRESH_TIMEOUT_MS,
          },
        ),
      catch: (error) => error,
    });
    if (refreshed.isErr()) {
      if (!failureReported) {
        failureReported = true;
        onRefreshFailure(refreshed.error);
      }
      return;
    }
    failureReported = false;
    if (refreshed.value === null) {
      return;
    }
    const { parsed, version } = refreshed.value;
    // Another refresh may have committed while this parameter read was in flight.
    if (!isNewerParameterVersion(version, current.version)) {
      return;
    }
    if (parsed.unknownGrantCount > 0) {
      logger.error("feature_access.unknown_grant", {
        "feature_access.unknown_grant_count": parsed.unknownGrantCount,
      });
    }
    // The timeout boundary also excludes reads that finish after their deadline.
    current = Object.freeze({ grants: parsed.grants, version });
  };

  return { read, refresh };
};

if (envBase.API_FEATURE_ACCESS_GRANTS.unknownGrantCount > 0) {
  logger.error("feature_access.unknown_grant", {
    "feature_access.unknown_grant_count":
      envBase.API_FEATURE_ACCESS_GRANTS.unknownGrantCount,
  });
}

let featureAccessGrantsState: FeatureAccessGrantsState = Object.freeze({
  grants: envBase.API_FEATURE_ACCESS_GRANTS.grants,
  version: null,
});

/** Synchronous hot-path read of grants and their source version. */
export const readFeatureAccessGrants = (): FeatureAccessGrantsState =>
  featureAccessGrantsState;

/** Open local replacement, including fixtures exercising strict access decisions. */
const replaceFeatureAccessGrants = (grants: FeatureAccessGrants): void => {
  featureAccessGrantsState = Object.freeze({ grants, version: null });
};

/** Grant configuration shared by every authenticated database entrypoint. */
export const envFeatureAccess = {
  get API_FEATURE_ACCESS_GRANTS() {
    return readFeatureAccessGrants().grants;
  },
  set API_FEATURE_ACCESS_GRANTS(grants: FeatureAccessGrants) {
    if (!isLocalDevOpen() && !isLocalTestRun()) {
      panic(
        "Feature access grants cannot be replaced outside local test or development runs",
      );
    }
    replaceFeatureAccessGrants(grants);
  },
};
if (!isLocalDevOpen() && !isLocalTestRun()) {
  Object.freeze(envFeatureAccess);
}

const createSsmGrantSource = (
  parameterName: string,
): FeatureAccessGrantSource => ({
  // Ciphertext reads expose the version without requiring decryption.
  readVersion: async (signal) => {
    const result = await readParameter({
      name: parameterName,
      decryption: "disabled",
      signal,
    });
    if (result.isErr()) {
      throw result.error;
    }
    return result.value.version;
  },
  readValue: async (signal) => {
    const result = await readParameter({
      name: parameterName,
      decryption: "enabled",
      signal,
    });
    if (result.isErr()) {
      throw result.error;
    }
    const parameter = result.value;
    return { raw: parameter.value, version: parameter.version };
  },
});

type StartFeatureAccessGrantsRefreshOptions = {
  parameterName?: string;
  source?: FeatureAccessGrantSource;
};

/** Loads configured grants before returning, then starts periodic refresh; null when off. */
export const startFeatureAccessGrantsRefresh = async ({
  parameterName = envBase.API_FEATURE_ACCESS_GRANTS_SSM_PARAMETER_NAME,
  source,
}: StartFeatureAccessGrantsRefreshOptions = {}): Promise<
  (() => Promise<void>) | null
> => {
  if (parameterName === undefined) {
    return null;
  }
  const owner = createFeatureAccessGrantsOwner({
    initial: featureAccessGrantsState,
    onRefreshFailure: (error) => {
      observeFailure(error, {
        sink: FEATURE_ACCESS_REFRESH_FAILED_SINK,
        ctx: ParameterStoreError.is(error)
          ? { parameterStoreReason: error.reason }
          : undefined,
      });
    },
    source: source ?? createSsmGrantSource(parameterName),
  });

  await owner.refresh();
  featureAccessGrantsState = owner.read();

  return startNonOverlappingInterval({
    initialDelayMs: FEATURE_ACCESS_REFRESH_INTERVAL_MS,
    intervalMs: FEATURE_ACCESS_REFRESH_INTERVAL_MS,
    onError: (error) => {
      panic(
        `Feature access refresh escaped its failure boundary: ${String(error)}`,
      );
    },
    run: async () => {
      await owner.refresh();
      featureAccessGrantsState = owner.read();
    },
  });
};

let deploymentFlagReader: ((flag: DeploymentFeatureFlag) => boolean) | null =
  null;

/**
 * Deployment flags belong to the API environment, which a base-environment
 * process (ingestion, the document worker) never loads. The API environment
 * binds its reader here once, so the flag owner decides for the database
 * layer without importing it.
 */
export const bindDeploymentFlagReader = (
  reader: (flag: DeploymentFeatureFlag) => boolean,
): void => {
  if (deploymentFlagReader !== null) {
    panic("Deployment flags are bound once");
  }
  deploymentFlagReader = reader;
};

/**
 * A deployment flag's configured value. Without the API environment every
 * flag reads at its schema default, off, so such a process admits no flagged
 * feature.
 */
export const readDeploymentFlag = (flag: DeploymentFeatureFlag): boolean =>
  deploymentFlagReader?.(flag) ?? false;
