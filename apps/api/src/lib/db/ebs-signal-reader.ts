import { panic, Result, TaggedError } from "better-result";

import type { HealthConfig, Signal } from "@stll/db-load-gate/health";
import {
  ebsBalance,
  type EbsBalanceReading,
} from "@stll/db-load-gate/indicators";

import {
  createEbsBalanceReader,
  type EbsBalanceReadError,
} from "./ebs-balance-reader";

type EbsEnvironment = {
  DB_LOAD_GATE_RDS_INSTANCE_IDENTIFIER?: string | undefined;
  DB_LOAD_GATE_EBS_SIGNAL?: "disabled" | undefined;
};
export type EbsConfiguration =
  | { type: "enabled"; instanceIdentifier: string }
  | { type: "disabled" }
  | { type: "missing" };

export const resolveEbsConfiguration = (
  environment: EbsEnvironment,
): EbsConfiguration => {
  const instanceIdentifier =
    environment.DB_LOAD_GATE_RDS_INSTANCE_IDENTIFIER?.trim();
  if (instanceIdentifier) {
    return { type: "enabled", instanceIdentifier };
  }
  if (environment.DB_LOAD_GATE_EBS_SIGNAL === "disabled") {
    return { type: "disabled" };
  }
  return { type: "missing" };
};

/** A configuration an operator chose: RDS metrics or an explicit opt-out. */
export type ConfiguredEbsConfiguration = Exclude<
  EbsConfiguration,
  { type: "missing" }
>;

const EBS_CONFIGURATION_KEYS = [
  "DB_LOAD_GATE_RDS_INSTANCE_IDENTIFIER",
  "DB_LOAD_GATE_EBS_SIGNAL",
] as const;

const EBS_CONFIGURATION_MISSING_MESSAGE =
  "Configure DB_LOAD_GATE_RDS_INSTANCE_IDENTIFIER for RDS, or explicitly set DB_LOAD_GATE_EBS_SIGNAL=disabled for non-RDS database maintenance.";

export class EbsConfigurationMissingError extends TaggedError(
  "EbsConfigurationMissingError",
)<{
  message: string;
  configurationKeys: readonly string[];
}> {}

/**
 * Work that must not wait on a setting nobody chose (the migrator) rejects a
 * missing configuration; background maintenance instead holds on it.
 */
export const requireEbsConfiguration = (
  configuration: EbsConfiguration,
): Result<ConfiguredEbsConfiguration, EbsConfigurationMissingError> =>
  configuration.type === "missing"
    ? Result.err(
        new EbsConfigurationMissingError({
          message: EBS_CONFIGURATION_MISSING_MESSAGE,
          configurationKeys: EBS_CONFIGURATION_KEYS,
        }),
      )
    : Result.ok(configuration);

export type EbsConfigurationEvent = {
  event: "database_load_gate_ebs_configuration_missing";
  severity: "error";
  message: string;
  configurationKeys: readonly string[];
};
type EbsSignalReaderOptions = {
  configuration: EbsConfiguration;
  clock: () => number;
  config: HealthConfig;
  createReader?: (options: {
    instanceIdentifier: string;
    clock: () => number;
    timeoutMs: number;
    maxStalenessMs: number;
  }) => () => Promise<Result<EbsBalanceReading, EbsBalanceReadError>>;
  log?: (event: EbsConfigurationEvent) => void;
};

/** Explicit opt-out is neutral; missing configuration always defers work. */
export const createEbsSignalReader = ({
  configuration,
  clock,
  config,
  createReader = createEbsBalanceReader,
  log = (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
}: EbsSignalReaderOptions): (() => Promise<Signal>) => {
  let loggedMissing = false;
  let read:
    | (() => Promise<Result<EbsBalanceReading, EbsBalanceReadError>>)
    | undefined;
  return async () => {
    switch (configuration.type) {
      case "enabled":
        return await ebsBalance({
          read: async () => {
            read ??= createReader({
              instanceIdentifier: configuration.instanceIdentifier,
              clock,
              timeoutMs: config.readTimeoutMs,
              maxStalenessMs: config.maxStalenessMs,
            });
            const outcome = await read();
            return outcome.isOk() ? outcome.value : null;
          },
          now: clock,
          config,
        });
      case "disabled":
        return {
          indicator: "ebs_balance",
          kind: "not_configured",
          value: null,
          threshold: null,
          observedAt: null,
          reason:
            "EBS signal explicitly disabled by DB_LOAD_GATE_EBS_SIGNAL=disabled",
        };
      case "missing":
        if (!loggedMissing) {
          loggedMissing = true;
          log({
            event: "database_load_gate_ebs_configuration_missing",
            severity: "error",
            message: EBS_CONFIGURATION_MISSING_MESSAGE,
            configurationKeys: EBS_CONFIGURATION_KEYS,
          });
        }
        return {
          indicator: "ebs_balance",
          kind: "unknown",
          value: null,
          threshold: null,
          observedAt: null,
          reason:
            "Missing DB_LOAD_GATE_RDS_INSTANCE_IDENTIFIER or explicit DB_LOAD_GATE_EBS_SIGNAL=disabled",
        };
      default: {
        configuration satisfies never;
        return panic("Unhandled EBS configuration");
      }
    }
  };
};
