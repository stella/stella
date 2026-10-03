import { panic, Result, TaggedError } from "better-result";

import type { HealthConfig, Signal } from "@stll/db-load-gate/health";
import {
  ebsBalance,
  type EbsBalanceReading,
} from "@stll/db-load-gate/indicators";
import { Temporal } from "@stll/time";

import {
  createEbsBalanceReader,
  EbsBalanceReadError,
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
type RawReaderOptions = {
  instanceIdentifier: string;
  clock: () => number;
  timeoutMs: number;
  maxStalenessMs: number;
};
type RawReader = () => Promise<Result<EbsBalanceReading, EbsBalanceReadError>>;
type RawReaderFactory = (options: RawReaderOptions) => RawReader;
const RAW_READING_CACHE_MS = 120_000;

type EbsReaderCacheOptions = {
  createReader: RawReaderFactory;
  clock: () => number;
};

/** Share provider requests, never rewrite the last real datapoint timestamp. */
export const createEbsReaderCache = ({
  createReader,
  clock,
}: EbsReaderCacheOptions) => {
  const readers = new Map<string, RawReader>();
  return (options: RawReaderOptions): RawReader => {
    const key = JSON.stringify([
      options.instanceIdentifier,
      options.timeoutMs,
      options.maxStalenessMs,
    ]);
    const existing = readers.get(key);
    if (existing !== undefined) {
      return existing;
    }
    let raw: RawReader | undefined;
    let lastAttempt: number | null = null;
    let lastReal: EbsBalanceReading | undefined;
    let cached: Result<EbsBalanceReading, EbsBalanceReadError> | undefined;
    let inFlight:
      | Promise<Result<EbsBalanceReading, EbsBalanceReadError>>
      | undefined;
    const read: RawReader = async () => {
      if (inFlight !== undefined) {
        return await inFlight;
      }
      const now = clock();
      if (
        cached !== undefined &&
        lastAttempt !== null &&
        now - lastAttempt >= 0 &&
        now - lastAttempt < RAW_READING_CACHE_MS
      ) {
        return cached;
      }
      lastAttempt = now;
      inFlight = (async () => {
        const attempted = await Result.tryPromise({
          try: async () => {
            raw ??= createReader(options);
            return await raw();
          },
          catch: (cause) =>
            new EbsBalanceReadError({
              message: "EBS cached metric request failed",
              cause,
            }),
        });
        const outcome = attempted.isOk()
          ? attempted.value
          : Result.err(attempted.error);
        if (outcome.isOk()) {
          lastReal = outcome.value;
        }
        cached =
          outcome.isErr() && lastReal !== undefined
            ? Result.ok(lastReal)
            : outcome;
        return cached;
      })();
      try {
        return await inFlight;
      } finally {
        inFlight = undefined;
      }
    };
    readers.set(key, read);
    return read;
  };
};

let sharedReaderFactory: RawReaderFactory | undefined;
const sharedReader: RawReaderFactory = (options) => {
  sharedReaderFactory ??= createEbsReaderCache({
    createReader: createEbsBalanceReader,
    clock: () => Temporal.Now.instant().epochMilliseconds,
  });
  return sharedReaderFactory(options);
};

type EbsSignalReaderOptions = {
  configuration: EbsConfiguration;
  clock: () => number;
  config: HealthConfig;
  createReader?: RawReaderFactory;
  log?: (event: EbsConfigurationEvent) => void;
};

/** Explicit opt-out is neutral; missing configuration always defers work. */
export const createEbsSignalReader = ({
  configuration,
  clock,
  config,
  createReader = sharedReader,
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
