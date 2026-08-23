import { createHash } from "node:crypto";
import { loadGroundTruthFile } from "../ground-truth";

export const PERFORMANCE_INPUT_SOURCE =
  "versioned performance scenarios and packages/benchmark/fixtures/en.json";

export const PERFORMANCE_SCENARIO_SCHEMA_VERSION = 1 as const;

export const PERFORMANCE_SCENARIO_IDS = [
  "fixture-mixed",
  "negative-prose",
  "sparse-entities",
  "dense-entities",
] as const;

export type PerformanceScenarioId = (typeof PERFORMANCE_SCENARIO_IDS)[number];

export type PerformanceScenario = {
  readonly type: "performance-input-scenario";
  readonly schemaVersion: typeof PERFORMANCE_SCENARIO_SCHEMA_VERSION;
  readonly id: PerformanceScenarioId;
};

export const DEFAULT_PERFORMANCE_SCENARIO_ID = "fixture-mixed" as const;

const NEGATIVE_PROSE_SEED =
  "The written terms apply to each section. Review the general policy before approval. " +
  "A later paragraph explains the ordinary process and the available remedy.\n";
const SPARSE_ENTITY_MARKER =
  "Contact sparse.person@example.test for assistance.\n";
const SPARSE_BLOCK_BYTES = 16 * 1024;
const DENSE_ENTITY_SEED =
  "Email dense.person@example.test or call +1 202 555 0147. " +
  "Reference account GB82 WEST 1234 5698 7654 32.\n";
const FIXTURE_MIXED_FILE = "en.json";

type PerformanceScenarioSource =
  | { readonly type: "fixture"; readonly file: string }
  | { readonly type: "literal"; readonly seed: string }
  | {
      readonly type: "sparse";
      readonly marker: string;
      readonly filler: string;
      readonly blockBytes: number;
    };

const PERFORMANCE_SCENARIO_SOURCES = {
  "fixture-mixed": { type: "fixture", file: FIXTURE_MIXED_FILE },
  "negative-prose": { type: "literal", seed: NEGATIVE_PROSE_SEED },
  "sparse-entities": {
    type: "sparse",
    marker: SPARSE_ENTITY_MARKER,
    filler: NEGATIVE_PROSE_SEED,
    blockBytes: SPARSE_BLOCK_BYTES,
  },
  "dense-entities": { type: "literal", seed: DENSE_ENTITY_SEED },
} as const satisfies Record<PerformanceScenarioId, PerformanceScenarioSource>;

const encoder = new TextEncoder();

const truncateUtf8 = (bytes: Uint8Array, targetBytes: number): string => {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = targetBytes;
  while (end > 0) {
    try {
      const prefix = decoder.decode(bytes.subarray(0, end));
      return prefix + " ".repeat(targetBytes - end);
    } catch {
      end -= 1;
    }
  }
  throw new Error("could not truncate performance input at a UTF-8 boundary");
};

type LoadPerformanceFixture = (
  file: string,
) => Promise<readonly { readonly text: string }[]>;

type PerformanceInputSourceDigestOptions = {
  readonly scenarioIds: readonly PerformanceScenarioId[];
  readonly loadFixture?: LoadPerformanceFixture | undefined;
};

export const performanceInputSourceDigest = async ({
  scenarioIds,
  loadFixture = loadGroundTruthFile,
}: PerformanceInputSourceDigestOptions): Promise<string> => {
  const hash = createHash("sha256");
  hash.update(`${PERFORMANCE_SCENARIO_SCHEMA_VERSION}\0`);
  for (const scenario of scenarioIds) {
    hash.update(`${scenario}\0`);
    const source = PERFORMANCE_SCENARIO_SOURCES[scenario];
    hash.update(`${source.type}\0`);
    switch (source.type) {
      case "fixture":
        hash.update(`${source.file}\0`);
        hash.update(await fixtureSeed(source.file, loadFixture));
        break;
      case "literal":
        hash.update(source.seed);
        break;
      case "sparse":
        hash.update(source.marker);
        hash.update(source.filler);
        hash.update(`${source.blockBytes}\0`);
        break;
    }
  }
  return hash.digest("hex");
};

export const performanceScenario = (
  id: PerformanceScenarioId,
): PerformanceScenario => ({
  type: "performance-input-scenario",
  schemaVersion: PERFORMANCE_SCENARIO_SCHEMA_VERSION,
  id,
});

export const parsePerformanceScenarioId = (
  value: string,
): PerformanceScenarioId => {
  const id = PERFORMANCE_SCENARIO_IDS.find((candidate) => candidate === value);
  if (id === undefined) {
    throw new Error(
      `unknown performance scenario ${value}; expected ${PERFORMANCE_SCENARIO_IDS.join(", ")}`,
    );
  }
  return id;
};

const repeatToUtf8Bytes = (seed: string, targetBytes: number): string => {
  const seedBytes = encoder.encode(seed);
  const repetitions = Math.ceil(targetBytes / seedBytes.length);
  return truncateUtf8(encoder.encode(seed.repeat(repetitions)), targetBytes);
};

const sparseEntitySeed = (
  source: Extract<PerformanceScenarioSource, { readonly type: "sparse" }>,
): string => {
  const remainingBytes =
    source.blockBytes - encoder.encode(source.marker).length;
  if (remainingBytes <= 0) {
    throw new Error("sparse performance marker exceeds its block size");
  }
  return source.marker + repeatToUtf8Bytes(source.filler, remainingBytes);
};

const fixtureSeed = async (
  file: string,
  loadFixture: LoadPerformanceFixture = loadGroundTruthFile,
): Promise<string> => {
  const documents = await loadFixture(file);
  if (documents.length === 0) {
    throw new Error("English synthetic performance fixtures are unavailable");
  }
  return documents.map(({ text }) => text).join("\n\n") + "\n\n";
};

const scenarioSeed = async (id: PerformanceScenarioId): Promise<string> => {
  const source = PERFORMANCE_SCENARIO_SOURCES[id];
  switch (source.type) {
    case "literal":
      return source.seed;
    case "sparse":
      return sparseEntitySeed(source);
    case "fixture":
      return fixtureSeed(source.file);
    default: {
      const unreachable: never = source;
      throw new Error(`unhandled performance source ${String(unreachable)}`);
    }
  }
};

export const buildPerformanceInput = async (
  targetBytes: number,
  scenarioId: PerformanceScenarioId = DEFAULT_PERFORMANCE_SCENARIO_ID,
): Promise<{
  readonly text: string;
  readonly sha256: string;
  readonly scenario: PerformanceScenario;
}> => {
  if (!Number.isSafeInteger(targetBytes) || targetBytes <= 0) {
    throw new Error("targetBytes must be a positive safe integer");
  }
  const text = repeatToUtf8Bytes(await scenarioSeed(scenarioId), targetBytes);
  const encoded = encoder.encode(text);
  if (encoded.length !== targetBytes) {
    throw new Error("performance input does not match its requested byte size");
  }
  return {
    text,
    sha256: createHash("sha256").update(encoded).digest("hex"),
    scenario: performanceScenario(scenarioId),
  };
};
