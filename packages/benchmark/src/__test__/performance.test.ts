import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  assertCanonicalHost,
  assertCanonicalRuntimeControls,
  CANONICAL_HOST_LABEL,
  parseCpuList,
  type HostProfile,
  type HostSnapshot,
} from "../performance/host";
import { buildPerformanceInput } from "../performance/input";
import {
  assertCleanCpuNoise,
  cpuNoiseDelta,
  type CpuNoiseSnapshot,
} from "../performance/noise";
import {
  assertPerformanceReport,
  PERFORMANCE_REPORT_SCHEMA_VERSION,
} from "../performance/report";
import {
  buildPerformanceWorkerInvocation,
  parsePerformanceArgs,
} from "../performance/run";
import { summarize } from "../performance/statistics";
import {
  buildProviderInvocation,
  buildProviderSampleOrder,
  parseCrossProviderArgs,
  providerDefinitions,
  type ProviderDefinition,
} from "../performance/providers/run";
import { CROSS_PROVIDER_IDS } from "../performance/providers/types";
import { regexDetectorConfig } from "../performance/providers/stella-config";
import { assertProviderEntities } from "../performance/providers/identity";
import {
  assertProviderInputIdentity,
  computeProviderInputIdentity,
} from "../performance/providers/input-identity";

describe("canonical performance statistics", () => {
  test("reports median, MAD, and nearest-rank p95 without sorting samples", () => {
    const values = [9, 1, 4, 2, 3];
    expect(summarize(values)).toEqual({
      samples: values,
      median: 3,
      medianAbsoluteDeviation: 1,
      p95: 9,
    });
  });

  test("builds deterministic exact-byte scaling inputs from public fixtures", async () => {
    const first = await buildPerformanceInput(48 * 1024);
    const second = await buildPerformanceInput(48 * 1024);
    expect(new TextEncoder().encode(first.text)).toHaveLength(48 * 1024);
    expect(first.sha256).toBe(second.sha256);
  });

  test("enforces the canonical sample floor and scale set", () => {
    expect(() => parsePerformanceArgs(["--canonical", "--samples=19"])).toThrow(
      "at least 3 warmups and 20 samples",
    );
    expect(() =>
      parsePerformanceArgs(["--canonical", "--sizes-kib=48,1024"]),
    ).toThrow("standard 48 KiB–1 MiB scale set");
    expect(parsePerformanceArgs(["--samples=1", "--warmups=1"]).samples).toBe(
      1,
    );
  });

  test("pins canonical workers and leaves local workers unpinned", () => {
    const canonical = buildPerformanceWorkerInvocation(49_152, {
      type: "canonical",
      benchmarkCpu: 6,
    });
    expect(canonical.command).toBe("taskset");
    expect(canonical.args.slice(0, 3)).toEqual([
      "--cpu-list",
      "6",
      process.execPath,
    ]);
    expect(canonical.args.at(-1)).toBe("49152");

    const local = buildPerformanceWorkerInvocation(49_152, { type: "local" });
    expect(local.command).toBe(process.execPath);
    expect(local.args).not.toContain("--cpu-list");
  });
});

describe("cross-provider performance contract", () => {
  test("defines every provider in the report contract", () => {
    expect(providerDefinitions().map(({ id }) => id)).toEqual([
      ...CROSS_PROVIDER_IDS,
    ]);
  });

  test("uses worker-verified UTF-16 input identity for astral text", () => {
    const inputText = "A😀B";
    const identity = computeProviderInputIdentity(inputText);
    expect(identity.inputBytes).toBe(6);
    expect(identity.inputCharacters).toBe(4);
    expect(() =>
      assertProviderInputIdentity(identity, inputText),
    ).not.toThrow();
    expect(() =>
      assertProviderInputIdentity(
        { ...identity, inputCharacters: identity.inputCharacters - 1 },
        inputText,
      ),
    ).toThrow("mismatched input identity");
    expect(() =>
      assertProviderInputIdentity(
        { ...identity, inputSha256: "0".repeat(64) },
        inputText,
      ),
    ).toThrow("mismatched input identity");
  });

  test("Python independently rejects a code-point denominator", () => {
    const python = Bun.which("python3") ?? Bun.which("python");
    if (python === null)
      throw new Error("Python is required by benchmark tests");
    const inputText = "A😀B";
    const identity = computeProviderInputIdentity(inputText);
    const result = Bun.spawnSync({
      cmd: [
        python,
        resolve(
          import.meta.dir,
          "..",
          "..",
          "python",
          "provider_performance_worker.py",
        ),
        "datafog-regex-only",
      ],
      stdin: new TextEncoder().encode(
        JSON.stringify({
          ...identity,
          inputCharacters: 3,
          inputText,
        }),
      ),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "Python worker received mismatched input identity",
    );
  });

  test("pins the provider interpreter and preserves its arguments", () => {
    const definition: ProviderDefinition = {
      id: "datafog-regex-only",
      command: "/venv/bin/python",
      args: ["worker.py", "datafog-regex-only"],
    };
    expect(buildProviderInvocation(definition, 6)).toEqual({
      command: "taskset",
      args: [
        "--cpu-list",
        "6",
        "/venv/bin/python",
        "worker.py",
        "datafog-regex-only",
      ],
    });
    expect(buildProviderInvocation(definition, null)).toEqual(definition);
  });

  test("keeps canonical sample and scale floors", () => {
    expect(() =>
      parseCrossProviderArgs(["--canonical", "--samples=19"]),
    ).toThrow("at least 3 warmups and 20 samples");
    expect(() =>
      parseCrossProviderArgs(["--canonical", "--samples=21"]),
    ).toThrow("even sample count");
    expect(
      parseCrossProviderArgs(["--samples=1", "--warmups=1"]).inputBytes,
    ).toEqual([48 * 1024, 256 * 1024]);
  });

  test("balances every provider and size without provider blocks", () => {
    const definitions: ProviderDefinition[] = [
      { id: "stella-full", command: "stella", args: [] },
      {
        id: "stella-regex-detectors-only",
        command: "stella-regex",
        args: [],
      },
      { id: "openredaction-default", command: "openredaction", args: [] },
      { id: "scrubadub-base", command: "scrubadub", args: [] },
      { id: "datafog-regex-only", command: "datafog", args: [] },
    ];
    const sizes = [48, 256, 512, 1024];
    const order = buildProviderSampleOrder(definitions, sizes, 0);
    expect(order).toHaveLength(definitions.length * sizes.length);
    expect(
      new Set(
        order.map(
          ({ definition, inputBytes }) => `${definition.id}:${inputBytes}`,
        ),
      ).size,
    ).toBe(order.length);
    expect(
      order.every(
        ({ definition }, index) =>
          index === 0 || definition.id !== order.at(index - 1)?.definition.id,
      ),
    ).toBe(true);
    expect(buildProviderSampleOrder(definitions, sizes, 1).at(-1)).toEqual(
      order.at(0),
    );

    const positions = new Map<string, number[]>();
    for (let round = 0; round < 20; round += 1) {
      for (const [position, coordinate] of buildProviderSampleOrder(
        definitions,
        sizes,
        round,
      ).entries()) {
        const key = `${coordinate.definition.id}:${coordinate.inputBytes}`;
        const seen = positions.get(key) ?? [];
        seen.push(position);
        positions.set(key, seen);
      }
    }
    const center = (order.length - 1) / 2;
    expect(
      [...positions.values()].every(
        (seen) =>
          seen.length === 20 &&
          seen.reduce((total, position) => total + position, 0) /
            seen.length ===
            center,
      ),
    ).toBe(true);
  });

  test("rejects invalid provider spans and labels", () => {
    expect(() =>
      assertProviderEntities([{ start: 0, end: 1, label: "email" }], 1),
    ).not.toThrow();
    expect(() =>
      assertProviderEntities([{ start: 0, end: 2, label: "email" }], 1),
    ).toThrow("invalid span");
    expect(() =>
      assertProviderEntities([{ start: 0, end: 1, label: "" }], 1),
    ).toThrow("invalid label");
  });

  test("removes every non-regex detector lane from stella", async () => {
    const anonymize = await import("@stll/anonymize");
    const binding = anonymize.loadNativeAnonymizeBinding();
    const assembled = await anonymize.prepareNativePipelineConfig({
      binding,
      config: {
        threshold: 0.3,
        language: "en",
        nameCorpusLanguages: ["en"],
        enableTriggerPhrases: false,
        enableRegex: true,
        enableLegalForms: false,
        enableNameCorpus: false,
        enableDenyList: false,
        enableGazetteer: false,
        enableCountries: false,
        enableConfidenceBoost: false,
        enableCoreference: false,
        enableHotwordRules: false,
        enableZoneClassification: false,
        labels: [...anonymize.DEFAULT_ENTITY_LABELS],
        workspaceId: "cross-provider-performance-test",
      },
    });
    expect(assembled.address_seed_data).toBeDefined();
    expect(assembled.address_context_data).toBeDefined();

    const regexOnly = regexDetectorConfig(assembled);
    expect(regexOnly.literal_patterns).toEqual([]);
    expect(regexOnly.address_seed_data).toBeUndefined();
    expect(regexOnly.address_context_data).toBeUndefined();
    expect(regexOnly.date_data).toBeUndefined();
    expect(regexOnly.monetary_data).toBeUndefined();
    expect(regexOnly.signature_data).toBeUndefined();
    const prepared = anonymize.createNativeAnonymizerFromConfig({
      binding,
      config: regexOnly,
    });
    expect(
      prepared.redactStaticEntities("Email legal@example.test")
        .resolvedEntities,
    ).toHaveLength(1);
  });
});

describe("canonical performance host", () => {
  const profile: HostProfile = {
    schemaVersion: 1,
    label: CANONICAL_HOST_LABEL,
    platform: "linux",
    architecture: "x64",
    cpuModel: "Canonical CPU",
    logicalCores: 8,
    totalMemoryBytes: 16_000_000_000,
    benchmarkCpu: 6,
    maximumLoadPerCore: 0.1,
    governor: "performance",
    turbo: "disabled",
  };
  const snapshot: HostSnapshot = {
    eventName: "workflow_dispatch",
    repository: "stella/anonymize",
    ref: "refs/heads/main",
    platform: "linux",
    architecture: "x64",
    cpuModel: "Canonical CPU",
    logicalCores: 8,
    totalMemoryBytes: 16_000_000_000,
    loadOneMinute: 0.4,
    isolatedCpus: [6],
    noHzFullCpus: [6],
    onlineCpus: [0, 1, 2, 3, 4, 5, 6],
    benchmarkCpuSiblings: [6],
    tasksetAvailable: true,
    governors: ["performance"],
    turboDisabled: true,
  };

  test("accepts only a matching, quiet, trusted host", () => {
    expect(() => assertCanonicalHost(profile, snapshot)).not.toThrow();
    expect(() =>
      assertCanonicalHost(profile, { ...snapshot, eventName: "pull_request" }),
    ).toThrow("trusted repository event");
    expect(() =>
      assertCanonicalHost(profile, {
        ...snapshot,
        ref: "refs/heads/feature",
      }),
    ).toThrow("trusted repository event");
    expect(() =>
      assertCanonicalHost(profile, { ...snapshot, loadOneMinute: 8 }),
    ).toThrow("load exceeds");
    expect(() =>
      assertCanonicalHost(profile, { ...snapshot, turboDisabled: false }),
    ).toThrow("turbo/boost");
    expect(() =>
      assertCanonicalHost(profile, { ...snapshot, isolatedCpus: [] }),
    ).toThrow("online and isolated");
    expect(() =>
      assertCanonicalHost(profile, { ...snapshot, noHzFullCpus: [] }),
    ).toThrow("nohz_full");
    expect(() =>
      assertCanonicalHost(profile, {
        ...snapshot,
        benchmarkCpuSiblings: [6, 7],
        onlineCpus: [...snapshot.onlineCpus, 7],
      }),
    ).toThrow("SMT siblings must be offline");
    expect(() =>
      assertCanonicalRuntimeControls(profile, {
        ...snapshot,
        loadOneMinute: 8,
      }),
    ).toThrow("changed during measurement");
  });

  test("records CPU counter noise and rejects any canonical contamination", () => {
    const before: CpuNoiseSnapshot = {
      userTicks: 1,
      niceTicks: 0,
      systemTicks: 1,
      idleTicks: 10,
      ioWaitTicks: 0,
      irqTicks: 0,
      softIrqTicks: 0,
      stealTicks: 0,
    };
    const clean = cpuNoiseDelta(before, { ...before, userTicks: 4 });
    expect(clean.status).toBe("clean");
    expect(() => assertCleanCpuNoise(clean)).not.toThrow();
    const noisy = cpuNoiseDelta(before, {
      ...before,
      softIrqTicks: 1,
      stealTicks: 1,
    });
    expect(noisy.status).toBe("kernel-noise-observed");
    expect(() => assertCleanCpuNoise(noisy)).toThrow("kernel noise");
    expect(() =>
      assertCleanCpuNoise({
        ...clean,
        irqTicks: 1,
        status: "kernel-noise-observed",
      }),
    ).toThrow("kernel noise");
    expect(cpuNoiseDelta(before, { ...before, niceTicks: 1 }).status).toBe(
      "kernel-noise-observed",
    );
    expect(cpuNoiseDelta(before, { ...before, ioWaitTicks: 1 }).status).toBe(
      "kernel-noise-observed",
    );
  });

  test("parses Linux CPU lists without accepting ambiguous syntax", () => {
    expect(
      parseCpuList({ value: "1-3,6,8-9\n", context: "test CPU list" }),
    ).toEqual([1, 2, 3, 6, 8, 9]);
    expect(parseCpuList({ value: "", context: "test CPU list" })).toEqual([]);
    expect(() =>
      parseCpuList({ value: "01", context: "test CPU list" }),
    ).toThrow("invalid CPU id");
  });
});

describe("canonical performance report schema", () => {
  test("accepts aggregate output identity and rejects unknown fields", () => {
    const distribution = {
      samples: [1],
      median: 1,
      medianAbsoluteDeviation: 0,
      p95: 1,
    };
    const report = {
      schemaVersion: PERFORMANCE_REPORT_SCHEMA_VERSION,
      createdAt: "2026-07-22T00:00:00.000Z",
      gitSha: "0123456",
      mode: "local",
      policy: "development-only",
      configuration: {
        warmups: 1,
        samples: 1,
        inputBytes: [49_152],
        processIsolation: "fresh-process-per-sample",
      },
      fixture: {
        kind: "public-safe-synthetic",
        source: "packages/benchmark/fixtures/en.json",
        sha256: "a".repeat(64),
      },
      machine: {
        platform: "linux",
        architecture: "x64",
        release: "test",
        cpuModel: "test",
        logicalCores: 1,
        totalMemoryBytes: 1,
        freeMemoryBytes: 0,
        benchmarkCpu: null,
        hostnameSha256: "b".repeat(64),
        bunVersion: "1.3.14",
        nodeVersion: "v22",
      },
      results: [
        {
          inputBytes: 49_152,
          inputCharacters: 49_152,
          inputSha256: "c".repeat(64),
          outputCount: 1,
          outputDigest: "d".repeat(64),
          startupSeconds: distribution,
          initSeconds: distribution,
          coldSeconds: distribution,
          warmSeconds: distribution,
          warmCharactersPerSecond: distribution,
        },
      ],
    };
    expect(() => assertPerformanceReport(report)).not.toThrow();
    expect(() =>
      assertPerformanceReport({ ...report, mode: "canonical" }),
    ).toThrow("must record their pinned benchmark CPU");
    expect(() =>
      assertPerformanceReport({
        ...report,
        mode: "canonical",
        machine: { ...report.machine, benchmarkCpu: 6 },
      }),
    ).not.toThrow();
    expect(() =>
      assertPerformanceReport({ ...report, text: "forbidden" }),
    ).toThrow("forbids field text");
  });
});
