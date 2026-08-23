import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";

import {
  convert_external_detection_batch,
  createNativePipelineFromConfig,
  loadNativeAnonymizeBinding,
  type PreparedNativePipeline,
} from "@stll/anonymize";

import type { GroundTruthDocument } from "../ground-truth";
import { loadStllBenchmarkConfig } from "./stella";
import {
  type Adapter,
  type AdapterOutcome,
  type NativePrediction,
  totalUtf16CodeUnits,
} from "./types";
import modelManifest from "../../native/nym-adapter/model-manifest.json";

const require = createRequire(import.meta.url);
const stellaVersion = (
  require("@stll/anonymize/package.json") as { version: string }
).version;

const PACKAGE_ROOT = join(import.meta.dir, "..", "..");
const NATIVE_ROOT = join(PACKAGE_ROOT, "native", "nym-adapter");
const NATIVE_BINARY = join(
  NATIVE_ROOT,
  "target",
  "release",
  `stella-nym-adapter${process.platform === "win32" ? ".exe" : ""}`,
);
const MODEL_DIRECTORY = join(
  PACKAGE_ROOT,
  ".cache",
  "nym-pii-multilingual-small",
  modelManifest.revision,
  modelManifest.subfolder,
);
const TIMEOUT_MS = 30 * 60 * 1000;

export const NYM_MODEL_REPO = modelManifest.repo;
export const NYM_MODEL_REVISION = modelManifest.revision;
export const NYM_PROVIDER_VERSION = `${modelManifest.repo}@${modelManifest.revision}/${modelManifest.subfolder}`;

type NymResult = {
  readonly version: string;
  readonly initSeconds: number;
  readonly coldSeconds: number;
  readonly warmSeconds: number;
  readonly results: readonly {
    readonly id: string;
    readonly batchJson: string;
  }[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const protocolError = (message: string): never => {
  throw new Error(`Nym adapter protocol error: ${message}`);
};

const finiteNonnegative = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return protocolError(`${field} must be a finite nonnegative number`);
  }
  return value;
};

/** Validate the small process envelope; Rust and the native import validate the batch. */
export const parseNymResult = (value: unknown): NymResult => {
  if (!isRecord(value)) return protocolError("root must be an object");
  const allowed = new Set([
    "version",
    "initSeconds",
    "coldSeconds",
    "warmSeconds",
    "results",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return protocolError("root contains an unexpected field");
  }
  if (value["version"] !== NYM_PROVIDER_VERSION) {
    return protocolError("provider version does not match the pinned model");
  }
  if (!Array.isArray(value["results"])) {
    return protocolError("results must be an array");
  }
  const results = value["results"].map((result) => {
    if (
      !isRecord(result) ||
      typeof result["id"] !== "string" ||
      result["id"].length === 0 ||
      typeof result["batchJson"] !== "string" ||
      result["batchJson"].length === 0 ||
      Object.keys(result).some((key) => key !== "id" && key !== "batchJson")
    ) {
      return protocolError("result must contain only id and batchJson");
    }
    return { id: result["id"], batchJson: result["batchJson"] };
  });
  return {
    version: value["version"],
    initSeconds: finiteNonnegative(value["initSeconds"], "initSeconds"),
    coldSeconds: finiteNonnegative(value["coldSeconds"], "coldSeconds"),
    warmSeconds: finiteNonnegative(value["warmSeconds"], "warmSeconds"),
    results,
  };
};

const sha256File = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

const artifactIsValid = async (
  path: string,
  expectedBytes: number,
  expectedSha256: string,
): Promise<boolean> => {
  try {
    const metadata = await stat(path);
    return (
      metadata.size === expectedBytes &&
      (await sha256File(path)) === expectedSha256
    );
  } catch {
    return false;
  }
};

const artifactHasExpectedSize = async (
  path: string,
  expectedBytes: number,
): Promise<boolean> => {
  try {
    return (await stat(path)).size === expectedBytes;
  } catch {
    return false;
  }
};

const provisionModel = async (): Promise<void> => {
  await mkdir(MODEL_DIRECTORY, { recursive: true });
  for (const artifact of modelManifest.artifacts) {
    const path = join(MODEL_DIRECTORY, artifact.name);
    // Rust verifies every cached SHA-256 immediately before model load. The
    // host only needs to decide whether provisioning is necessary; avoiding a
    // second 151 MB hash pass keeps cached initialization honest and lean.
    if (await artifactHasExpectedSize(path, artifact.bytes)) continue;

    const url = `https://huggingface.co/${modelManifest.repo}/resolve/${modelManifest.revision}/${modelManifest.subfolder}/${artifact.name}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `could not download pinned Nym artifact ${artifact.name}: HTTP ${response.status}`,
      );
    }
    const responseBytes = Number(response.headers.get("content-length"));
    if (!Number.isFinite(responseBytes) || responseBytes !== artifact.bytes) {
      throw new Error(
        `pinned Nym artifact size header mismatch: ${artifact.name}`,
      );
    }
    const temporary = `${path}.${process.pid}.download`;
    try {
      if (response.body === null) {
        throw new Error(`pinned Nym artifact has no body: ${artifact.name}`);
      }
      await streamPipeline(
        Readable.fromWeb(response.body),
        createWriteStream(temporary, { flags: "wx" }),
      );
      if (
        !(await artifactIsValid(temporary, artifact.bytes, artifact.sha256))
      ) {
        throw new Error(
          `pinned Nym artifact failed verification: ${artifact.name}`,
        );
      }
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
};

const predictionsFromPipeline = (
  binding: ReturnType<typeof loadNativeAnonymizeBinding>,
  pipeline: PreparedNativePipeline,
  doc: GroundTruthDocument,
  batchJson: string,
): NativePrediction[] => {
  const detections = convert_external_detection_batch(
    new TextEncoder().encode(doc.text),
    batchJson,
    { binding },
  );
  return pipeline
    .redactTextWithCallerDetections(doc.text, { detections })
    .resolvedEntities.map(({ start, end, label, text }) => ({
      start,
      end,
      label,
      text,
    }));
};

const runNativeNym = async (
  docs: readonly GroundTruthDocument[],
): Promise<NymResult> => {
  const proc = Bun.spawn([NATIVE_BINARY, MODEL_DIRECTORY], {
    stdin: new TextEncoder().encode(
      JSON.stringify({
        docs: docs.map(({ id, language, text }) => ({ id, language, text })),
      }),
    ),
    stdout: "pipe",
    stderr: "pipe",
    timeout: TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    const tail = stderr.trim().split("\n").slice(-5).join(" | ");
    throw new Error(`native Nym adapter crashed (exit ${exitCode}): ${tail}`);
  }
  try {
    return parseNymResult(JSON.parse(stdout));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new Error(`native Nym adapter emitted an invalid result: ${detail}`);
  }
};

export const createNymAssistedAdapter = (): Adapter => ({
  name: "stella+nym-pii",
  version: `${stellaVersion} + ${NYM_PROVIDER_VERSION}`,
  run: async (
    docs: readonly GroundTruthDocument[],
  ): Promise<AdapterOutcome> => {
    if (!existsSync(NATIVE_BINARY)) {
      return {
        status: "unavailable",
        reasonCode: "adapter-unavailable",
        reason:
          "optional native Nym adapter is not built; create it using the pinned command in REPRODUCING.md",
      };
    }
    if (docs.some(({ language }) => language.trim().toLowerCase() !== "de")) {
      throw new Error(
        "stella+nym-pii assisted lane accepts German documents only",
      );
    }

    const initStart = performance.now();
    await provisionModel();
    const binding = loadNativeAnonymizeBinding();
    const pipeline = await createNativePipelineFromConfig({
      binding,
      config: await loadStllBenchmarkConfig("de"),
      gazetteerEntries: [],
    });
    const hostInitSeconds = (performance.now() - initStart) / 1000;
    const nym = await runNativeNym(docs);

    const batchesById = new Map<string, string>();
    for (const { id, batchJson } of nym.results) {
      if (batchesById.has(id)) throw new Error(`Nym adapter duplicated ${id}`);
      batchesById.set(id, batchJson);
    }
    if (
      nym.results.length !== docs.length ||
      batchesById.size !== docs.length
    ) {
      throw new Error("Nym adapter omitted or duplicated documents");
    }

    const predictions = new Map<string, readonly NativePrediction[]>();
    const fusionColdStart = performance.now();
    for (const doc of docs) {
      const batchJson = batchesById.get(doc.id);
      if (batchJson === undefined) throw new Error(`Nym omitted ${doc.id}`);
      predictions.set(
        doc.id,
        predictionsFromPipeline(binding, pipeline, doc, batchJson),
      );
    }
    const fusionColdSeconds = (performance.now() - fusionColdStart) / 1000;

    const fusionWarmStart = performance.now();
    for (const doc of docs) {
      predictionsFromPipeline(
        binding,
        pipeline,
        doc,
        batchesById.get(doc.id) ?? protocolError(`Nym omitted ${doc.id}`),
      );
    }
    const fusionWarmSeconds = (performance.now() - fusionWarmStart) / 1000;

    return {
      status: "ok",
      predictions,
      timing: {
        initSeconds: hostInitSeconds + nym.initSeconds,
        coldSeconds: nym.coldSeconds + fusionColdSeconds,
        warmSeconds: nym.warmSeconds + fusionWarmSeconds,
        totalChars: totalUtf16CodeUnits(docs),
      },
      reportedVersion: `${stellaVersion} + ${nym.version}`,
      notes:
        "opt-in native ONNX PII assistance; non-PII legal entity classes intentionally remain stella-only",
    };
  },
});
