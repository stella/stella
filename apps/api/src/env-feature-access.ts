import {
  DescribeParametersCommand,
  GetParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { panic } from "better-result";
import * as v from "valibot";

import { envBase } from "@/api/env-base";
import type { DeploymentFeatureFlag } from "@/api/lib/deployment-feature";
import type { FeatureAccessGrants } from "@/api/lib/feature-access/grants-schema";
import { featureAccessGrantsEnvSchema } from "@/api/lib/feature-access/grants-schema";
import { startNonOverlappingInterval } from "@/api/lib/non-overlapping-interval";
import { logger } from "@/api/lib/observability/logger";
import { isLocalDevOpen } from "@/api/runtime-mode";

/** Metadata polling bounds grant propagation without adding work to requests. */
export const FEATURE_ACCESS_REFRESH_INTERVAL_MS = 60_000;

export type FeatureAccessGrantsState = Readonly<{
  grants: FeatureAccessGrants;
  /** Null only when grants came from the process environment rather than SSM. */
  version: number | null;
}>;

type FeatureAccessGrantSource = {
  readValue: () => Promise<{ raw: string; version: number }>;
  readVersion: () => Promise<number>;
};

type CreateFeatureAccessGrantsOwnerOptions = {
  initial: FeatureAccessGrantsState;
  onRefreshFailure: (error: unknown) => void;
  source: FeatureAccessGrantSource;
};

export const createFeatureAccessGrantsOwner = ({
  initial,
  onRefreshFailure,
  source,
}: CreateFeatureAccessGrantsOwnerOptions) => {
  let current = initial;
  let failureReported = false;

  const read = (): FeatureAccessGrantsState => current;
  const refresh = async (): Promise<void> => {
    try {
      const version = await source.readVersion();
      if (version === current.version) {
        failureReported = false;
        return;
      }
      const loaded = await source.readValue();
      const parsed = v.parse(featureAccessGrantsEnvSchema, loaded.raw);
      current = Object.freeze({
        grants: parsed.grants,
        version: loaded.version,
      });
      failureReported = false;
    } catch (error) {
      if (!failureReported) {
        failureReported = true;
        onRefreshFailure(error);
      }
    }
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

/** Test-only open-mode replacement, retained for existing integration fixtures. */
const replaceFeatureAccessGrants = (grants: FeatureAccessGrants): void => {
  featureAccessGrantsState = Object.freeze({ grants, version: null });
};

/** Grant configuration shared by every authenticated database entrypoint. */
export const envFeatureAccess = {
  get API_FEATURE_ACCESS_GRANTS() {
    return readFeatureAccessGrants().grants;
  },
  set API_FEATURE_ACCESS_GRANTS(grants: FeatureAccessGrants) {
    if (!isLocalDevOpen()) {
      panic("Feature access grants cannot be replaced outside open mode");
    }
    replaceFeatureAccessGrants(grants);
  },
};
if (!isLocalDevOpen()) {
  Object.freeze(envFeatureAccess);
}

export const startFeatureAccessGrantsRefresh = () => {
  const parameterName = envBase.API_FEATURE_ACCESS_GRANTS_SSM_PARAMETER_NAME;
  if (parameterName === undefined) {
    return (): Promise<void> => Promise.resolve();
  }

  const client = new SSMClient({});
  const owner = createFeatureAccessGrantsOwner({
    initial: featureAccessGrantsState,
    onRefreshFailure: () => {
      logger.error("feature_access.refresh_failed");
    },
    source: {
      readVersion: async () => {
        const output = await client.send(
          new DescribeParametersCommand({
            ParameterFilters: [
              { Key: "Name", Option: "Equals", Values: [parameterName] },
            ],
            MaxResults: 1,
          }),
        );
        return (
          output.Parameters?.at(0)?.Version ??
          panic("Feature access grant parameter metadata has no version")
        );
      },
      readValue: async () => {
        const output = await client.send(
          new GetParameterCommand({
            Name: parameterName,
            WithDecryption: true,
          }),
        );
        return {
          raw:
            output.Parameter?.Value ??
            panic("Feature access grant parameter has no value"),
          version:
            output.Parameter?.Version ??
            panic("Feature access grant parameter has no version"),
        };
      },
    },
  });

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
