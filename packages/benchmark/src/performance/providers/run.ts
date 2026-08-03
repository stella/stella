import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

import { benchmarkGitRevision } from "../../git-revision";
import {
  assertCanonicalRuntimeControls,
  currentHostSnapshot,
  verifyCanonicalHost,
} from "../host";
import {
  buildPerformanceInput,
  PERFORMANCE_INPUT_SOURCE,
  performanceInputSourceDigest,
} from "../input";
import { machineMetadata, type PerformanceMachine } from "../report";
import {
  assertCleanCpuNoise,
  cpuNoiseDelta,
  readCpuNoiseSnapshot,
  type CpuNoiseDelta,
} from "../noise";
import { summarize } from "../statistics";
import {
  CROSS_PROVIDER_IDS,
  CROSS_PROVIDER_REPORT_SCHEMA_VERSION,
  type CrossProviderId,
  type IsolatedProviderSample,
  type ProviderResult,
  type ProviderSample,
} from "./types";

const KIBIBYTE = 1024;
const DEFAULT_INPUT_BYTES = [48 * KIBIBYTE, 256 * KIBIBYTE] as const;
const CANONICAL_INPUT_BYTES = [
  48 * KIBIBYTE,
  256 * KIBIBYTE,
  512 * KIBIBYTE,
  1024 * KIBIBYTE,
] as const;
const DEFAULT_WARMUPS = 3;
const DEFAULT_SAMPLES = 20;
const PROVIDER_SAMPLE_TIMEOUT_MS = 2 * 60 * 1000;

type CrossProviderOptions = {
  readonly mode: "local" | "canonical";
  readonly warmups: number;
  readonly samples: number;
  readonly inputBytes: readonly number[];
  readonly outputPath: string | undefined;
};

export type ProviderAvailability =
  | { readonly status: "available"; readonly provider: CrossProviderId }
  | {
      readonly status: "unavailable";
      readonly provider: CrossProviderId;
      readonly reason: string;
    };

export type CrossProviderReport = {
  readonly schemaVersion: typeof CROSS_PROVIDER_REPORT_SCHEMA_VERSION;
  readonly createdAt: string;
  readonly gitSha: string;
  readonly mode: "local" | "canonical";
  readonly policy: "development-only";
  readonly methodology: {
    readonly processIsolation: "fresh-process-per-provider-size-sample";
    readonly startupBoundary: "spawn-to-worker-ready";
    readonly initBoundary: "provider-import-and-pipeline-construction";
    readonly wallBoundary: "spawn-to-clean-worker-exit";
    readonly processCpuBoundary: "worker-start-through-output-validation";
    readonly passesPerProcess: "one-first-call-one-second-call";
    readonly sampleOrder: "balanced-diagonal-rotation";
    readonly interpretation: string;
  };
  readonly configuration: {
    readonly warmups: number;
    readonly samples: number;
    readonly inputBytes: readonly number[];
  };
  readonly fixture: {
    readonly kind: "public-safe-synthetic";
    readonly source: string;
    readonly sha256: string;
  };
  readonly machine: PerformanceMachine;
  readonly hostNoise: CpuNoiseDelta | null;
  readonly providers: readonly ProviderAvailability[];
  readonly results: readonly ProviderResult[];
};

const positiveInteger = (value: string, name: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
};

export const parseCrossProviderArgs = (
  args: readonly string[],
): CrossProviderOptions => {
  let mode: CrossProviderOptions["mode"] = "local";
  let warmups = DEFAULT_WARMUPS;
  let samples = DEFAULT_SAMPLES;
  let inputBytes: readonly number[] = DEFAULT_INPUT_BYTES;
  let outputPath: string | undefined;
  for (const argument of args) {
    if (argument === "--canonical") {
      mode = "canonical";
      inputBytes = CANONICAL_INPUT_BYTES;
      continue;
    }
    const [name, value] = argument.split("=", 2);
    if (value === undefined) throw new Error(`unknown argument ${argument}`);
    if (name === "--warmups") warmups = positiveInteger(value, name);
    else if (name === "--samples") samples = positiveInteger(value, name);
    else if (name === "--sizes-kib") {
      inputBytes = value
        .split(",")
        .map((size) => positiveInteger(size, name) * KIBIBYTE);
    } else if (name === "--output") {
      if (value === "") throw new Error("--output must not be empty");
      outputPath = resolve(value);
    } else throw new Error(`unknown argument ${argument}`);
  }
  if (
    inputBytes.some((size) => size < 48 * KIBIBYTE || size > 1024 * KIBIBYTE)
  ) {
    throw new Error(
      "provider performance sizes must be between 48 KiB and 1 MiB",
    );
  }
  if (
    mode === "canonical" &&
    (warmups < DEFAULT_WARMUPS || samples < DEFAULT_SAMPLES)
  ) {
    throw new Error(
      "canonical mode requires at least 3 warmups and 20 samples",
    );
  }
  if (mode === "canonical" && samples % 2 !== 0) {
    throw new Error("canonical mode requires an even sample count");
  }
  if (
    mode === "canonical" &&
    (inputBytes.length !== CANONICAL_INPUT_BYTES.length ||
      inputBytes.some((size, index) => size !== CANONICAL_INPUT_BYTES[index]))
  ) {
    throw new Error(
      "canonical mode requires the standard 48 KiB–1 MiB scale set",
    );
  }
  return { mode, warmups, samples, inputBytes, outputPath };
};

export type ProviderDefinition = {
  readonly id: CrossProviderId;
  readonly command: string;
  readonly args: readonly string[];
  readonly requiredModule?: string;
};

const pythonExecutable = (environmentName: string, venvName: string): string =>
  process.env[environmentName] ??
  resolve(import.meta.dir, "..", "..", "..", venvName, "bin", "python");

export const providerDefinitions = (): readonly ProviderDefinition[] => {
  const stellaWorker = resolve(import.meta.dir, "stella-worker.ts");
  const openRedactionWorker = resolve(
    import.meta.dir,
    "openredaction-worker.ts",
  );
  const pythonWorker = resolve(
    import.meta.dir,
    "..",
    "..",
    "..",
    "python",
    "provider_performance_worker.py",
  );
  return [
    {
      id: "stella-full",
      command: process.execPath,
      args: [stellaWorker, "stella-full"],
    },
    {
      id: "stella-regex-detectors-only",
      command: process.execPath,
      args: [stellaWorker, "stella-regex-detectors-only"],
    },
    {
      id: "openredaction-default",
      command: process.execPath,
      args: [openRedactionWorker],
    },
    {
      id: "scrubadub-base",
      command: pythonExecutable(
        "ANONYMIZE_SCRUBADUB_PYTHON",
        ".venv-scrubadub",
      ),
      args: [pythonWorker, "scrubadub-base"],
      requiredModule: "scrubadub",
    },
    {
      id: "datafog-regex-only",
      command: pythonExecutable("ANONYMIZE_DATAFOG_PYTHON", ".venv-datafog"),
      args: [pythonWorker, "datafog-regex-only"],
      requiredModule: "datafog",
    },
  ];
};

export const buildProviderInvocation = (
  definition: ProviderDefinition,
  benchmarkCpu: number | null,
): { readonly command: string; readonly args: readonly string[] } => {
  if (benchmarkCpu === null) return definition;
  return {
    command: "taskset",
    args: [
      "--cpu-list",
      `${benchmarkCpu}`,
      definition.command,
      ...definition.args,
    ],
  };
};

type SampleRequest = {
  readonly inputBytes: number;
  readonly inputCharacters: number;
  readonly inputText: string;
  readonly inputSha256: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const assertProviderSample: (
  value: unknown,
  expectedProvider: CrossProviderId,
) => asserts value is ProviderSample = (value, expectedProvider) => {
  if (!isRecord(value)) throw new Error("provider sample must be an object");
  const keys = [
    "provider",
    "providerVersion",
    "runtimeVersion",
    "scope",
    "inputBytes",
    "inputCharacters",
    "inputSha256",
    "outputCount",
    "outputDigest",
    "outputLabelCounts",
    "initSeconds",
    "firstCallSeconds",
    "secondCallSeconds",
    "processCpuSeconds",
  ];
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !(key in value))
  ) {
    throw new Error("provider sample fields do not match schema version 2");
  }
  if (
    value["provider"] !== expectedProvider ||
    typeof value["providerVersion"] !== "string" ||
    value["providerVersion"] === "" ||
    typeof value["runtimeVersion"] !== "string" ||
    value["runtimeVersion"] === "" ||
    ![
      "full-pipeline",
      "base-install",
      "regex-only",
      "regex-detectors-only",
    ].includes(typeof value["scope"] === "string" ? value["scope"] : "") ||
    !Number.isSafeInteger(value["inputBytes"]) ||
    !Number.isSafeInteger(value["inputCharacters"]) ||
    typeof value["inputSha256"] !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value["inputSha256"]) ||
    !Number.isSafeInteger(value["outputCount"]) ||
    typeof value["outputDigest"] !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value["outputDigest"]) ||
    !isRecord(value["outputLabelCounts"]) ||
    [
      "initSeconds",
      "firstCallSeconds",
      "secondCallSeconds",
      "processCpuSeconds",
    ].some((key) => {
      const timing = value[key];
      return (
        typeof timing !== "number" || !Number.isFinite(timing) || timing < 0
      );
    })
  ) {
    throw new Error("provider sample values are invalid");
  }
  let labelTotal = 0;
  for (const count of Object.values(value["outputLabelCounts"])) {
    if (
      !Number.isSafeInteger(count) ||
      (typeof count === "number" && count < 0)
    ) {
      throw new Error("provider output label counts are invalid");
    }
    if (typeof count !== "number") {
      throw new Error("provider output label count must be numeric");
    }
    labelTotal += count;
  }
  if (labelTotal !== value["outputCount"]) {
    throw new Error("provider output label counts do not sum to outputCount");
  }
};

const assertSampleMatchesRequest = (
  sample: ProviderSample,
  request: SampleRequest,
): void => {
  if (
    sample.inputBytes !== request.inputBytes ||
    sample.inputCharacters !== request.inputCharacters ||
    sample.inputSha256 !== request.inputSha256
  ) {
    throw new Error(`${sample.provider} returned mismatched input identity`);
  }
};

const runProviderSample = (
  definition: ProviderDefinition,
  request: SampleRequest,
  benchmarkCpu: number | null,
): Promise<IsolatedProviderSample> =>
  new Promise((resolveSample, reject) => {
    const spawnedAt = performance.now();
    const invocation = buildProviderInvocation(definition, benchmarkCpu);
    const child = spawn(invocation.command, invocation.args, {
      cwd: resolve(import.meta.dir, "..", "..", "..", "..", ".."),
      env: process.env,
      timeout: PROVIDER_SAMPLE_TIMEOUT_MS,
      killSignal: "SIGKILL",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let startupSeconds: number | undefined;
    let sample: ProviderSample | undefined;
    let standardError = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      standardError += chunk;
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch (error) {
        reject(
          new Error(`${definition.id} emitted invalid JSON`, {
            cause: error,
          }),
        );
        child.kill();
        return;
      }
      if (!isRecord(message)) {
        reject(new Error(`${definition.id} emitted a non-object message`));
        child.kill();
        return;
      }
      if (message["type"] === "ready") {
        if (startupSeconds !== undefined) {
          reject(new Error(`${definition.id} emitted ready twice`));
          child.kill();
          return;
        }
        startupSeconds = (performance.now() - spawnedAt) / 1000;
        child.stdin.write(JSON.stringify(request));
        child.stdin.end();
        return;
      }
      if (message["type"] !== "result") {
        reject(new Error(`${definition.id} emitted an unknown message type`));
        child.kill();
        return;
      }
      const candidate = message["sample"];
      try {
        assertProviderSample(candidate, definition.id);
        assertSampleMatchesRequest(candidate, request);
      } catch (error) {
        reject(
          new Error(`${definition.id} emitted an invalid sample`, {
            cause: error,
          }),
        );
        child.kill();
        return;
      }
      sample = candidate;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0) {
        reject(
          new Error(
            `${definition.id} worker failed with code ${code} and signal ${signal ?? "none"}: ${standardError.trim()}`,
          ),
        );
        return;
      }
      if (startupSeconds === undefined || sample === undefined) {
        reject(new Error(`${definition.id} worker protocol was incomplete`));
        return;
      }
      resolveSample({
        ...sample,
        startupSeconds,
        wallSeconds: (performance.now() - spawnedAt) / 1000,
      });
    });
  });

const sameLabels = (
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): boolean => JSON.stringify(left) === JSON.stringify(right);

const providerAvailability = (
  definition: ProviderDefinition,
): ProviderAvailability => {
  if (!existsSync(definition.command)) {
    return {
      status: "unavailable",
      provider: definition.id,
      reason: `interpreter not found at ${definition.command}`,
    };
  }
  if (definition.requiredModule === undefined) {
    return { status: "available", provider: definition.id };
  }
  const probe = spawnSync(
    definition.command,
    ["-c", `import ${definition.requiredModule}`],
    { stdio: "ignore" },
  );
  return probe.status === 0
    ? { status: "available", provider: definition.id }
    : {
        status: "unavailable",
        provider: definition.id,
        reason: `${definition.requiredModule} is not importable by ${definition.command}`,
      };
};

const assertSameOutput = (
  expected: IsolatedProviderSample,
  actual: IsolatedProviderSample,
): void => {
  if (
    expected.provider !== actual.provider ||
    expected.providerVersion !== actual.providerVersion ||
    expected.runtimeVersion !== actual.runtimeVersion ||
    expected.scope !== actual.scope ||
    expected.inputBytes !== actual.inputBytes ||
    expected.inputSha256 !== actual.inputSha256 ||
    expected.outputCount !== actual.outputCount ||
    expected.outputDigest !== actual.outputDigest ||
    !sameLabels(expected.outputLabelCounts, actual.outputLabelCounts)
  ) {
    throw new Error(
      `${actual.provider} output changed at ${actual.inputBytes} bytes`,
    );
  }
};

const rotated = <T>(values: readonly T[], round: number): readonly T[] => {
  const offset = round % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
};

export type ProviderSampleCoordinate = {
  readonly definition: ProviderDefinition;
  readonly inputBytes: number;
};

export const buildProviderSampleOrder = (
  definitions: readonly ProviderDefinition[],
  inputBytes: readonly number[],
  round: number,
): readonly ProviderSampleCoordinate[] => {
  if (definitions.length === 0 || inputBytes.length === 0) {
    throw new Error("provider sample order inputs must not be empty");
  }
  const diagonal: ProviderSampleCoordinate[] = [];
  for (let sizeOffset = 0; sizeOffset < inputBytes.length; sizeOffset += 1) {
    for (
      let providerIndex = 0;
      providerIndex < definitions.length;
      providerIndex += 1
    ) {
      const definition = definitions.at(providerIndex);
      const size = inputBytes.at(
        (providerIndex + sizeOffset) % inputBytes.length,
      );
      if (definition === undefined || size === undefined) {
        throw new Error("provider sample order inputs must not be empty");
      }
      diagonal.push({ definition, inputBytes: size });
    }
  }
  const paired = rotated(diagonal, Math.floor(round / 2));
  return round % 2 === 0 ? paired : [...paired].reverse();
};

export const runCrossProviderPerformance = async (
  options: CrossProviderOptions,
): Promise<CrossProviderReport> => {
  const host = options.mode === "canonical" ? verifyCanonicalHost() : undefined;
  const benchmarkCpu = host?.benchmarkCpu ?? null;
  const gitSha = benchmarkGitRevision();
  if (options.mode === "canonical" && gitSha.endsWith("-dirty")) {
    throw new Error("canonical provider runs require a clean Git worktree");
  }

  const definitions = providerDefinitions();
  const availability = definitions.map(providerAvailability);
  if (
    options.mode === "canonical" &&
    availability.some(({ status }) => status === "unavailable")
  ) {
    throw new Error("canonical provider runs require every provider");
  }
  const available = definitions.filter((definition) =>
    availability.some(
      (entry) =>
        entry.provider === definition.id && entry.status === "available",
    ),
  );
  const inputs = new Map<
    number,
    Awaited<ReturnType<typeof buildPerformanceInput>>
  >();
  for (const size of options.inputBytes) {
    inputs.set(size, await buildPerformanceInput(size));
  }

  const expected = new Map<string, IsolatedProviderSample>();
  const measured = new Map<string, IsolatedProviderSample[]>();
  const noiseStart =
    benchmarkCpu === null ? null : readCpuNoiseSnapshot(benchmarkCpu);
  for (let round = 0; round < options.warmups + options.samples; round += 1) {
    const phase = round < options.warmups ? "warmup" : "sample";
    const phaseRound =
      round < options.warmups ? round + 1 : round - options.warmups + 1;
    const phaseTotal =
      round < options.warmups ? options.warmups : options.samples;
    const phaseRoundIndex =
      phase === "warmup" ? round : round - options.warmups;
    for (const { definition, inputBytes: size } of buildProviderSampleOrder(
      available,
      options.inputBytes,
      phaseRoundIndex,
    )) {
      process.stderr.write(
        `${phase} ${phaseRound}/${phaseTotal}: ${definition.id}, ${size} bytes\n`,
      );
      const input = inputs.get(size);
      if (input === undefined) {
        throw new Error(`missing input for ${size} bytes`);
      }
      const sample = await runProviderSample(
        definition,
        {
          inputBytes: size,
          inputCharacters: input.text.length,
          inputText: input.text,
          inputSha256: input.sha256,
        },
        benchmarkCpu,
      );
      const key = `${definition.id}:${size}`;
      const identity = expected.get(key);
      if (identity === undefined) expected.set(key, sample);
      else assertSameOutput(identity, sample);
      if (phase === "sample") {
        const samples = measured.get(key) ?? [];
        samples.push(sample);
        measured.set(key, samples);
      }
    }
  }

  const hostNoise =
    benchmarkCpu === null || noiseStart === null
      ? null
      : cpuNoiseDelta(noiseStart, readCpuNoiseSnapshot(benchmarkCpu));
  if (host !== undefined && hostNoise !== null) {
    assertCleanCpuNoise(hostNoise);
    assertCanonicalRuntimeControls(
      host,
      currentHostSnapshot(host.benchmarkCpu),
    );
  }

  const results: ProviderResult[] = [];
  for (const definition of available) {
    for (const size of options.inputBytes) {
      const key = `${definition.id}:${size}`;
      const identity = expected.get(key);
      const samples = measured.get(key);
      if (identity === undefined || samples === undefined) {
        throw new Error(`missing samples for ${key}`);
      }
      results.push({
        provider: identity.provider,
        providerVersion: identity.providerVersion,
        runtimeVersion: identity.runtimeVersion,
        scope: identity.scope,
        inputBytes: identity.inputBytes,
        inputCharacters: identity.inputCharacters,
        inputSha256: identity.inputSha256,
        outputCount: identity.outputCount,
        outputDigest: identity.outputDigest,
        outputLabelCounts: identity.outputLabelCounts,
        startupSeconds: summarize(
          samples.map(({ startupSeconds }) => startupSeconds),
        ),
        wallSeconds: summarize(samples.map(({ wallSeconds }) => wallSeconds)),
        initSeconds: summarize(samples.map(({ initSeconds }) => initSeconds)),
        firstCallSeconds: summarize(
          samples.map(({ firstCallSeconds }) => firstCallSeconds),
        ),
        secondCallSeconds: summarize(
          samples.map(({ secondCallSeconds }) => secondCallSeconds),
        ),
        processCpuSeconds: summarize(
          samples.map(({ processCpuSeconds }) => processCpuSeconds),
        ),
        secondCallCharactersPerSecond: summarize(
          samples.map(
            ({ inputCharacters, secondCallSeconds }) =>
              inputCharacters / secondCallSeconds,
          ),
        ),
      });
    }
  }

  return {
    schemaVersion: CROSS_PROVIDER_REPORT_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    gitSha,
    mode: options.mode,
    policy: "development-only",
    methodology: {
      processIsolation: "fresh-process-per-provider-size-sample",
      startupBoundary: "spawn-to-worker-ready",
      initBoundary: "provider-import-and-pipeline-construction",
      wallBoundary: "spawn-to-clean-worker-exit",
      processCpuBoundary: "worker-start-through-output-validation",
      passesPerProcess: "one-first-call-one-second-call",
      sampleOrder: "balanced-diagonal-rotation",
      interpretation:
        "The closest like-for-like lanes are stella's built-in regex detectors, OpenRedaction's stateless local configuration, and DataFog's regex engine; their pattern sets, context processing, and result resolution still differ. stella full and scrubadub base cover broader, different detector sets. Speed must be read beside output counts and digests.",
    },
    configuration: {
      warmups: options.warmups,
      samples: options.samples,
      inputBytes: [...options.inputBytes],
    },
    fixture: {
      kind: "public-safe-synthetic",
      source: PERFORMANCE_INPUT_SOURCE,
      sha256: performanceInputSourceDigest(),
    },
    machine: await machineMetadata(benchmarkCpu),
    hostNoise,
    providers: CROSS_PROVIDER_IDS.map(
      (provider) =>
        availability.find((entry) => entry.provider === provider) ?? {
          status: "unavailable" as const,
          provider,
          reason: "provider definition missing",
        },
    ),
    results,
  };
};

if (import.meta.main) {
  const options = parseCrossProviderArgs(process.argv.slice(2));
  const report = await runCrossProviderPerformance(options);
  const serialized = `${JSON.stringify(report, undefined, 2)}\n`;
  if (options.outputPath === undefined) process.stdout.write(serialized);
  else {
    mkdirSync(dirname(options.outputPath), { recursive: true });
    await Bun.write(options.outputPath, serialized);
    process.stderr.write(`wrote ${options.outputPath}\n`);
  }
}
