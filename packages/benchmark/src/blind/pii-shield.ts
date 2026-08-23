import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GroundTruthDocument } from "../ground-truth";
import type {
  Adapter,
  AdapterOutcome,
  NativePrediction,
} from "../adapters/types";

const SCAN_TIMEOUT_MS = 5 * 60 * 1000;
const MACOS_NATIVE_TEARDOWN_EXIT = 134;
const MACOS_NATIVE_TEARDOWN_ERROR = "mutex lock failed: Invalid argument";
const UNAVAILABLE_REASON =
  "pii-shield CLI or its GLiNER model is unavailable; run `pii-shield doctor` and `pii-shield install-model`, then set PII_SHIELD_BIN if needed";

export const parsePiiShieldEntities = (
  value: unknown,
  text: string,
  documentId: string,
): NativePrediction[] => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("entities" in value) ||
    !Array.isArray(value.entities)
  ) {
    throw new Error(`PII-Shield returned malformed output for ${documentId}`);
  }
  return value.entities.map((item) => {
    if (
      item === null ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      !("start" in item) ||
      !("end" in item) ||
      !("type" in item) ||
      !("text" in item) ||
      typeof item.start !== "number" ||
      typeof item.end !== "number" ||
      typeof item.type !== "string" ||
      typeof item.text !== "string" ||
      !Number.isSafeInteger(item.start) ||
      !Number.isSafeInteger(item.end) ||
      item.start < 0 ||
      item.end <= item.start ||
      item.end > text.length ||
      text.slice(item.start, item.end) !== item.text
    ) {
      throw new Error(`PII-Shield returned an invalid span for ${documentId}`);
    }
    return {
      start: item.start,
      end: item.end,
      label: item.type,
      text: item.text,
    };
  });
};

const command = (): string => process.env["PII_SHIELD_BIN"] ?? "pii-shield";

const runProcess = async (args: readonly string[]) => {
  const process = Bun.spawn([command(), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: SCAN_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
};

export const createPiiShieldAdapter = (): Adapter => ({
  name: "pii-shield",
  version: "unknown",
  run: async (
    documents: readonly GroundTruthDocument[],
  ): Promise<AdapterOutcome> => {
    if (
      (command().includes("/") || command().includes("\\")) &&
      !existsSync(command())
    ) {
      return {
        status: "unavailable",
        reasonCode: "adapter-unavailable",
        reason: `PII_SHIELD_BIN does not exist: ${command()}`,
      };
    }
    let version: Awaited<ReturnType<typeof runProcess>>;
    try {
      version = await runProcess(["--version"]);
    } catch {
      return {
        status: "unavailable",
        reasonCode: "adapter-unavailable",
        reason: UNAVAILABLE_REASON,
      };
    }
    if (version.exitCode !== 0) {
      return {
        status: "unavailable",
        reasonCode: "adapter-unavailable",
        reason: UNAVAILABLE_REASON,
      };
    }

    // The public CLI requires its GLiNER model even though `--version` works
    // without one. Preflight the documented health command so a normal
    // first-run installation remains an optional unavailable adapter instead
    // of aborting every other benchmark comparison.
    let doctor: Awaited<ReturnType<typeof runProcess>>;
    try {
      doctor = await runProcess(["doctor"]);
    } catch {
      return {
        status: "unavailable",
        reasonCode: "adapter-unavailable",
        reason: UNAVAILABLE_REASON,
      };
    }
    if (doctor.exitCode !== 0) {
      return {
        status: "unavailable",
        reasonCode: "adapter-unavailable",
        reason: UNAVAILABLE_REASON,
      };
    }

    const directory = await mkdtemp(join(tmpdir(), "stella-blind-pii-shield-"));
    const predictions = new Map<string, readonly NativePrediction[]>();
    const start = performance.now();
    try {
      for (const [index, document] of documents.entries()) {
        // Corpus IDs are metadata, not paths (RedactionBench IDs contain `/`).
        // A sequence local to this private temp directory is collision-free
        // and cannot create nested or traversed paths.
        const input = join(directory, `${index}.txt`);
        await Bun.write(input, document.text);
        const scan = await runProcess([
          "scan",
          input,
          "--json",
          "--lang",
          document.language,
          "--wait-ner",
          "300",
        ]);
        let parsed: unknown;
        try {
          parsed = JSON.parse(scan.stdout);
        } catch {
          const tail = scan.stderr.trim().split("\n").slice(-3).join(" | ");
          throw new Error(
            `PII-Shield returned no valid JSON for ${document.id} (exit ${scan.exitCode}): ${tail}`,
          );
        }
        const toleratedMacosTeardown =
          process.platform === "darwin" &&
          scan.exitCode === MACOS_NATIVE_TEARDOWN_EXIT &&
          scan.stderr.includes(MACOS_NATIVE_TEARDOWN_ERROR);
        if (scan.exitCode !== 0 && !toleratedMacosTeardown) {
          const tail = scan.stderr.trim().split("\n").slice(-3).join(" | ");
          throw new Error(
            `PII-Shield scan failed for ${document.id} (exit ${scan.exitCode}): ${tail}`,
          );
        }
        predictions.set(
          document.id,
          parsePiiShieldEntities(parsed, document.text, document.id),
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    const elapsed = (performance.now() - start) / 1000;
    const totalChars = documents.reduce(
      (sum, document) => sum + document.text.length,
      0,
    );
    return {
      status: "ok",
      predictions,
      timing: {
        initSeconds: 0,
        coldSeconds: elapsed,
        warmSeconds: elapsed,
        totalChars,
      },
      reportedVersion: version.stdout.trim(),
      notes:
        "CLI scan --json; one isolated temporary text file per document; complete validated JSON accepted before PII-Shield 2.2.0 macOS native teardown exit 134",
    };
  },
});
