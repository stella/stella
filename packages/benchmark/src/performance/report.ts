import { cpus, freemem, hostname, platform, release, totalmem } from "node:os";

import {
  PERFORMANCE_SCENARIO_IDS,
  PERFORMANCE_SCENARIO_SCHEMA_VERSION,
  type PerformanceScenario,
  type PerformanceScenarioId,
} from "./input";
import type { PerformanceRuntime } from "./sample";
import type { Distribution } from "./statistics";

export const PERFORMANCE_REPORT_SCHEMA_VERSION = 2 as const;

export type PerformanceMachine = {
  readonly platform: string;
  readonly architecture: string;
  readonly release: string;
  readonly cpuModel: string;
  readonly logicalCores: number;
  readonly totalMemoryBytes: number;
  readonly freeMemoryBytes: number;
  /** Linux logical CPU used by canonical workers; local runs are unpinned. */
  readonly benchmarkCpu: number | null;
  readonly hostnameSha256: string;
  readonly bunVersion: string;
  readonly nodeVersion: string;
};

export type PerformanceResult = {
  readonly scenario: PerformanceScenario;
  readonly runtime: PerformanceRuntime;
  readonly inputBytes: number;
  readonly inputCharacters: number;
  readonly inputSha256: string;
  readonly outputCount: number;
  readonly outputDigest: string;
  readonly startupSeconds: Distribution;
  readonly initSeconds: Distribution;
  readonly coldSeconds: Distribution;
  readonly warmSeconds: Distribution;
  readonly warmCharactersPerSecond: Distribution;
};

export type PerformanceReport = {
  readonly schemaVersion: typeof PERFORMANCE_REPORT_SCHEMA_VERSION;
  readonly createdAt: string;
  readonly gitSha: string;
  readonly mode: "local" | "canonical";
  readonly policy: "development-only";
  readonly configuration: {
    readonly warmups: number;
    readonly samples: number;
    readonly inputBytes: readonly number[];
    readonly scenarios: readonly PerformanceScenarioId[];
    readonly processIsolation: "fresh-process-per-sample";
  };
  readonly fixture: {
    readonly kind: "public-safe-synthetic";
    readonly source: string;
    readonly sha256: string;
  };
  readonly machine: PerformanceMachine;
  readonly results: readonly PerformanceResult[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isPerformanceScenarioId = (
  value: unknown,
): value is PerformanceScenarioId =>
  PERFORMANCE_SCENARIO_IDS.some((candidate) => candidate === value);

const exactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
  context: string,
): void => {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new Error(`${context} forbids field ${key}`);
  }
  for (const key of keys) {
    if (!(key in value)) throw new Error(`${context} is missing field ${key}`);
  }
};

const requireNonNegative = (value: unknown, context: string): void => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${context} must be finite and non-negative`);
  }
};

const requireNonNegativeInteger = (value: unknown, context: string): void => {
  if (
    !Number.isSafeInteger(value) ||
    (typeof value === "number" && value < 0)
  ) {
    throw new Error(`${context} must be a non-negative safe integer`);
  }
};

const requirePositiveInteger = (value: unknown, context: string): void => {
  if (
    !Number.isSafeInteger(value) ||
    (typeof value === "number" && value <= 0)
  ) {
    throw new Error(`${context} must be a positive safe integer`);
  }
};

const requireString = (value: unknown, context: string): void => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
};

const requireSha256 = (value: unknown, context: string): void => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${context} must be a lowercase SHA-256 digest`);
  }
};

const assertPerformanceScenario: (
  value: unknown,
  expectedId: PerformanceScenarioId,
) => asserts value is PerformanceScenario = (value, expectedId) => {
  if (!isRecord(value)) throw new Error("scenario must be an object");
  exactKeys(value, ["type", "schemaVersion", "id"], "scenario");
  if (
    value["type"] !== "performance-input-scenario" ||
    value["schemaVersion"] !== PERFORMANCE_SCENARIO_SCHEMA_VERSION ||
    value["id"] !== expectedId
  ) {
    throw new Error("result scenario does not match configuration order");
  }
};

const assertPerformanceRuntime: (
  value: unknown,
  expectedVersion: string,
) => asserts value is PerformanceRuntime = (value, expectedVersion) => {
  if (!isRecord(value)) throw new Error("runtime must be an object");
  exactKeys(value, ["type", "version"], "runtime");
  if (
    value["type"] !== "bun-native-binding" ||
    value["version"] !== expectedVersion
  ) {
    throw new Error("result runtime does not match machine Bun version");
  }
};

const assertDistribution = (
  value: unknown,
  sampleCount: number,
  context: string,
): void => {
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  exactKeys(
    value,
    ["samples", "median", "medianAbsoluteDeviation", "p95"],
    context,
  );
  if (
    !Array.isArray(value["samples"]) ||
    value["samples"].length !== sampleCount
  ) {
    throw new Error(`${context} must contain ${sampleCount} samples`);
  }
  for (const sample of value["samples"]) {
    requireNonNegative(sample, `${context} sample`);
  }
  requireNonNegative(value["median"], `${context} median`);
  requireNonNegative(
    value["medianAbsoluteDeviation"],
    `${context} medianAbsoluteDeviation`,
  );
  requireNonNegative(value["p95"], `${context} p95`);
};

export const assertPerformanceReport: (
  value: unknown,
) => asserts value is PerformanceReport = (value) => {
  if (!isRecord(value)) throw new Error("performance report must be an object");
  exactKeys(
    value,
    [
      "schemaVersion",
      "createdAt",
      "gitSha",
      "mode",
      "policy",
      "configuration",
      "fixture",
      "machine",
      "results",
    ],
    "performance report",
  );
  if (value["schemaVersion"] !== PERFORMANCE_REPORT_SCHEMA_VERSION) {
    throw new Error("performance report schema version is unsupported");
  }
  requireString(value["createdAt"], "createdAt");
  requireString(value["gitSha"], "gitSha");
  if (value["mode"] !== "local" && value["mode"] !== "canonical") {
    throw new Error("mode must be local or canonical");
  }
  if (value["policy"] !== "development-only") {
    throw new Error("policy must be development-only");
  }

  const configuration = value["configuration"];
  if (!isRecord(configuration))
    throw new Error("configuration must be an object");
  exactKeys(
    configuration,
    ["warmups", "samples", "inputBytes", "scenarios", "processIsolation"],
    "configuration",
  );
  requirePositiveInteger(configuration["warmups"], "warmups");
  requirePositiveInteger(configuration["samples"], "samples");
  if (
    !Array.isArray(configuration["inputBytes"]) ||
    configuration["inputBytes"].length === 0
  ) {
    throw new Error("inputBytes must be a non-empty array");
  }
  for (const size of configuration["inputBytes"]) {
    requirePositiveInteger(size, "inputBytes entry");
  }
  if (
    new Set(configuration["inputBytes"]).size !==
    configuration["inputBytes"].length
  ) {
    throw new Error("inputBytes entries must be unique");
  }
  if (
    !Array.isArray(configuration["scenarios"]) ||
    configuration["scenarios"].length === 0
  ) {
    throw new Error("scenarios must be a non-empty array");
  }
  for (const scenario of configuration["scenarios"]) {
    if (!isPerformanceScenarioId(scenario)) {
      throw new Error("scenario entry is unsupported");
    }
  }
  if (
    new Set(configuration["scenarios"]).size !==
    configuration["scenarios"].length
  ) {
    throw new Error("scenario entries must be unique");
  }
  if (configuration["processIsolation"] !== "fresh-process-per-sample") {
    throw new Error("processIsolation is unsupported");
  }

  const fixture = value["fixture"];
  if (!isRecord(fixture)) throw new Error("fixture must be an object");
  exactKeys(fixture, ["kind", "source", "sha256"], "fixture");
  if (fixture["kind"] !== "public-safe-synthetic") {
    throw new Error("fixture must be public-safe synthetic data");
  }
  requireString(fixture["source"], "fixture source");
  requireSha256(fixture["sha256"], "fixture sha256");

  const machine = value["machine"];
  if (!isRecord(machine)) throw new Error("machine must be an object");
  const machineKeys = [
    "platform",
    "architecture",
    "release",
    "cpuModel",
    "logicalCores",
    "totalMemoryBytes",
    "freeMemoryBytes",
    "benchmarkCpu",
    "hostnameSha256",
    "bunVersion",
    "nodeVersion",
  ];
  exactKeys(machine, machineKeys, "machine");
  for (const key of machineKeys.filter(
    (candidate) =>
      ![
        "logicalCores",
        "totalMemoryBytes",
        "freeMemoryBytes",
        "benchmarkCpu",
      ].includes(candidate),
  )) {
    requireString(machine[key], `machine ${key}`);
  }
  requirePositiveInteger(machine["logicalCores"], "logicalCores");
  requirePositiveInteger(machine["totalMemoryBytes"], "totalMemoryBytes");
  requireNonNegative(machine["freeMemoryBytes"], "freeMemoryBytes");
  if (machine["benchmarkCpu"] !== null) {
    requireNonNegativeInteger(machine["benchmarkCpu"], "benchmarkCpu");
  }
  if (value["mode"] === "canonical" && machine["benchmarkCpu"] === null) {
    throw new Error("canonical reports must record their pinned benchmark CPU");
  }
  if (value["mode"] === "local" && machine["benchmarkCpu"] !== null) {
    throw new Error("local reports must remain unpinned");
  }
  requireSha256(machine["hostnameSha256"], "hostnameSha256");
  const bunVersion = machine["bunVersion"];
  if (typeof bunVersion !== "string") {
    throw new Error("machine Bun version must be a string");
  }

  if (!Array.isArray(value["results"]))
    throw new Error("results must be an array");
  if (
    value["results"].length !==
    configuration["inputBytes"].length * configuration["scenarios"].length
  ) {
    throw new Error(
      "results must contain one entry per scenario and input size",
    );
  }
  const sampleCount = configuration["samples"];
  if (typeof sampleCount !== "number")
    throw new Error("sample count is invalid");
  for (const [index, result] of value["results"].entries()) {
    if (!isRecord(result))
      throw new Error("performance result must be an object");
    exactKeys(
      result,
      [
        "scenario",
        "runtime",
        "inputBytes",
        "inputCharacters",
        "inputSha256",
        "outputCount",
        "outputDigest",
        "startupSeconds",
        "initSeconds",
        "coldSeconds",
        "warmSeconds",
        "warmCharactersPerSecond",
      ],
      "performance result",
    );
    const scenarioIndex = Math.floor(
      index / configuration["inputBytes"].length,
    );
    const expectedScenario = configuration["scenarios"].at(scenarioIndex);
    if (!isPerformanceScenarioId(expectedScenario)) {
      throw new Error("configured scenario is invalid");
    }
    assertPerformanceScenario(result["scenario"], expectedScenario);
    assertPerformanceRuntime(result["runtime"], bunVersion);
    requirePositiveInteger(result["inputBytes"], "result inputBytes");
    if (
      result["inputBytes"] !==
      configuration["inputBytes"].at(index % configuration["inputBytes"].length)
    ) {
      throw new Error("result inputBytes do not match configuration order");
    }
    requirePositiveInteger(result["inputCharacters"], "result inputCharacters");
    requireSha256(result["inputSha256"], "result inputSha256");
    requireNonNegativeInteger(result["outputCount"], "result outputCount");
    requireSha256(result["outputDigest"], "result outputDigest");
    for (const key of [
      "startupSeconds",
      "initSeconds",
      "coldSeconds",
      "warmSeconds",
      "warmCharactersPerSecond",
    ]) {
      assertDistribution(result[key], sampleCount, key);
    }
  }
};

export const machineMetadata = async (
  benchmarkCpu: number | null,
): Promise<PerformanceMachine> => {
  const { createHash } = await import("node:crypto");
  const processors = cpus();
  const firstProcessor = processors.at(0);
  if (firstProcessor === undefined)
    throw new Error("CPU metadata is unavailable");
  return {
    platform: platform(),
    architecture: process.arch,
    release: release(),
    cpuModel: firstProcessor.model,
    logicalCores: processors.length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    benchmarkCpu,
    hostnameSha256: createHash("sha256").update(hostname()).digest("hex"),
    bunVersion: Bun.version,
    nodeVersion: process.version,
  };
};
