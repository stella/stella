import { existsSync } from "node:fs";
import { join } from "node:path";

import type { GroundTruthDocument } from "../ground-truth";
import {
  totalUtf16CodeUnits,
  type Adapter,
  type AdapterOutcome,
  type NativePrediction,
} from "./types";

const PYTHON_ADAPTER_TIMEOUT_MS = 10 * 60 * 1000;

const PACKAGE_ROOT = join(import.meta.dir, "..", "..");

type PythonResult = {
  version: string;
  activeDetectors?: string[];
  initSeconds: number;
  coldSeconds: number;
  warmSeconds: number;
  results: { id: string; entities: NativePrediction[] }[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const protocolError = (message: string): never => {
  throw new Error(`Python adapter protocol error: ${message}`);
};

const parseFiniteNonnegativeNumber = (
  value: unknown,
  field: string,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return protocolError(`${field} must be a finite nonnegative number`);
  }
  return value;
};

const parsePrediction = (value: unknown): NativePrediction => {
  if (!isRecord(value)) {
    return protocolError("entity must be an object");
  }
  const { start, end, label, text } = value;
  if (
    typeof start !== "number" ||
    !Number.isInteger(start) ||
    start < 0 ||
    typeof end !== "number" ||
    !Number.isInteger(end) ||
    end <= start
  ) {
    return protocolError(
      "entity offsets must be increasing nonnegative integers",
    );
  }
  if (typeof label !== "string" || label.length === 0) {
    return protocolError("entity label must be a nonempty string");
  }
  if (typeof text !== "string") {
    return protocolError("entity text must be a string");
  }
  return { start, end, label, text };
};

/** Validate the Python subprocess contract before any predictions are scored. */
export const parsePythonResult = (value: unknown): PythonResult => {
  if (!isRecord(value)) {
    return protocolError("root must be an object");
  }

  const allowedRootKeys = new Set([
    "version",
    "activeDetectors",
    "initSeconds",
    "coldSeconds",
    "warmSeconds",
    "results",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedRootKeys.has(key)) {
      return protocolError(`root contains unexpected field ${key}`);
    }
  }

  const { version, activeDetectors, results } = value;
  if (typeof version !== "string" || version.length === 0) {
    return protocolError("version must be a nonempty string");
  }
  if (!Array.isArray(results)) {
    return protocolError("results must be an array");
  }

  let parsedActiveDetectors: string[] | undefined;
  if (activeDetectors !== undefined) {
    if (
      !Array.isArray(activeDetectors) ||
      activeDetectors.some(
        (detector) => typeof detector !== "string" || detector.length === 0,
      )
    ) {
      return protocolError("activeDetectors must contain nonempty strings");
    }
    parsedActiveDetectors = activeDetectors;
  }

  const parsedResults = results.map((result) => {
    if (!isRecord(result)) {
      return protocolError("result must be an object");
    }
    const { id, entities } = result;
    if (typeof id !== "string" || id.length === 0) {
      return protocolError("result id must be a nonempty string");
    }
    if (!Array.isArray(entities)) {
      return protocolError("result entities must be an array");
    }
    return { id, entities: entities.map(parsePrediction) };
  });

  return {
    version,
    ...(parsedActiveDetectors === undefined
      ? {}
      : { activeDetectors: parsedActiveDetectors }),
    initSeconds: parseFiniteNonnegativeNumber(
      value["initSeconds"],
      "initSeconds",
    ),
    coldSeconds: parseFiniteNonnegativeNumber(
      value["coldSeconds"],
      "coldSeconds",
    ),
    warmSeconds: parseFiniteNonnegativeNumber(
      value["warmSeconds"],
      "warmSeconds",
    ),
    results: parsedResults,
  };
};

export type PythonAdapterOptions = {
  readonly name: string;
  /** Virtualenv directory under the package root (created via REPRODUCING.md). */
  readonly venvDir: string;
  /** Adapter script under python/. */
  readonly script: string;
  readonly languageSupport:
    | { readonly type: "all" }
    | {
        readonly type: "allowlist";
        readonly languages: readonly string[];
      };
};

/**
 * A non-zero exit whose stderr names a missing import/model is a setup gap
 * (the venv exists but its requirements or model wheels are not installed), not
 * a crash. These are skipped with instructions; every other failure is fatal.
 */
const SETUP_ERROR_MARKERS = [
  "ModuleNotFoundError",
  "ImportError",
  "No module named",
  "Can't find model", // spaCy model wheel not installed
  "OSError: [E050]", // spaCy: model not found
] as const;

const isSetupError = (stderr: string): boolean =>
  SETUP_ERROR_MARKERS.some((marker) => stderr.includes(marker));

/**
 * Adapter backed by a Python virtualenv. If the venv or its interpreter is
 * missing, the adapter reports `unavailable` with the exact command to create
 * it, rather than failing the whole run.
 */
export const createPythonAdapter = ({
  name,
  venvDir,
  script,
  languageSupport,
}: PythonAdapterOptions): Adapter => {
  const pythonBin = join(PACKAGE_ROOT, venvDir, "bin", "python");
  const scriptPath = join(PACKAGE_ROOT, "python", script);

  return {
    name,
    version: "unknown",
    run: async (
      docs: readonly GroundTruthDocument[],
    ): Promise<AdapterOutcome> => {
      if (languageSupport.type === "allowlist") {
        const supported = new Set(languageSupport.languages);
        const unsupported = [
          ...new Set(
            docs
              .map(({ language }) => language)
              .filter((language) => !supported.has(language)),
          ),
        ].sort();
        if (unsupported.length > 0) {
          return {
            status: "unavailable",
            reasonCode: "language-unsupported",
            reason: `${name} does not support corpus languages: ${unsupported.join(", ")}`,
          };
        }
      }
      if (!existsSync(pythonBin)) {
        return {
          status: "unavailable",
          reasonCode: "adapter-unavailable",
          reason: `virtualenv not found at ${venvDir}; create it per REPRODUCING.md`,
        };
      }

      const job = JSON.stringify({
        docs: docs.map(({ id, language, text }) => ({ id, language, text })),
      });

      const proc = Bun.spawn([pythonBin, scriptPath], {
        stdin: new TextEncoder().encode(job),
        stdout: "pipe",
        stderr: "pipe",
        // A hung model load must not block the benchmark forever.
        timeout: PYTHON_ADAPTER_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      if (exitCode !== 0) {
        const tail = stderr.trim().split("\n").slice(-3).join(" | ");
        // A missing dependency (venv exists but was never `uv pip install`-ed,
        // or a model wheel is absent) is a setup gap, not a bug: skip it with
        // the fix, exactly like a missing venv. Any other non-zero exit is a
        // real crash in the adapter or the library and must fail the run loudly
        // rather than be silently downgraded to "unavailable".
        if (isSetupError(stderr)) {
          return {
            status: "unavailable",
            reasonCode: "adapter-unavailable",
            reason: `${name} venv is incomplete (${tail}); reinstall it per REPRODUCING.md`,
          };
        }
        throw new Error(`${name} adapter crashed (exit ${exitCode}): ${tail}`);
      }

      let rawResult: unknown;
      try {
        rawResult = JSON.parse(stdout);
      } catch {
        throw new Error(`${name} adapter emitted malformed JSON`);
      }
      let parsed: PythonResult;
      try {
        parsed = parsePythonResult(rawResult);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown error";
        throw new Error(`${name} adapter protocol failure: ${detail}`);
      }

      const textById = new Map(docs.map((doc) => [doc.id, doc.text]));
      const predictions = new Map<string, readonly NativePrediction[]>();
      for (const { id, entities } of parsed.results) {
        const text = textById.get(id);
        if (text === undefined) {
          throw new Error(`${name} adapter returned an unexpected document id`);
        }
        if (predictions.has(id)) {
          throw new Error(`${name} adapter returned a duplicate document id`);
        }
        const codePoints: string[] = [];
        for (const codePoint of text) {
          codePoints.push(codePoint);
        }
        for (const entity of entities) {
          if (
            entity.end > codePoints.length ||
            codePoints.slice(entity.start, entity.end).join("") !== entity.text
          ) {
            throw new Error(`${name} adapter returned an invalid entity span`);
          }
        }
        predictions.set(id, convertCodePointSpans(text, entities));
      }
      if (predictions.size !== docs.length) {
        throw new Error(`${name} adapter omitted one or more documents`);
      }

      return {
        status: "ok",
        predictions,
        timing: {
          initSeconds: parsed.initSeconds,
          coldSeconds: parsed.coldSeconds,
          warmSeconds: parsed.warmSeconds,
          // Python `len` counts Unicode code points, while scoring offsets and
          // JavaScript strings use UTF-16 code units. Keep corpus size outside
          // the subprocess contract so every provider has one authoritative
          // denominator even when documents contain astral characters.
          totalChars: totalUtf16CodeUnits(docs),
        },
        reportedVersion: parsed.version,
        notes: parsed.activeDetectors
          ? `active detectors: ${parsed.activeDetectors.join(", ")}`
          : undefined,
      };
    },
  };
};

/**
 * Python string indices count Unicode code points; the scorer, fixtures, and
 * the JS adapters all use UTF-16 code units. Convert spans by prefix-scanning
 * the document once: identical for BMP-only text, correct when astral-plane
 * characters (emoji, rare CJK) precede an entity.
 */
export const convertCodePointSpans = (
  text: string,
  entities: readonly NativePrediction[],
): NativePrediction[] => {
  // utf16Offsets[i] = UTF-16 offset of code point i; last entry = text.length.
  const utf16Offsets: number[] = [];
  let offset = 0;
  for (const ch of text) {
    utf16Offsets.push(offset);
    offset += ch.length;
  }
  utf16Offsets.push(text.length);
  const toUtf16 = (codePoint: number): number =>
    utf16Offsets[Math.min(codePoint, utf16Offsets.length - 1)] ?? text.length;
  return entities.map((entity) => ({
    ...entity,
    start: toUtf16(entity.start),
    end: toUtf16(entity.end),
  }));
};
