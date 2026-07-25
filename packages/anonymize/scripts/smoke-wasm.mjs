#!/usr/bin/env node
/** Foundational smoke for the generated single-thread wasm-bindgen module. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import init, {
  convertExternalDetectionBatchJson,
  externalDetectionLimitsJson,
  inspectPdfJson,
  nativePackageVersion,
  normalizeForSearch,
  WasmPreparedSearch,
} from "../native-wasm-dist/index.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const wasmBytes = readFileSync(
  join(packageRoot, "native-wasm-dist", "index_bg.wasm"),
);
const module = await WebAssembly.compile(wasmBytes);
const imports = WebAssembly.Module.imports(module);
if (imports.some(({ module: name }) => name.startsWith("wasi"))) {
  throw new Error("browser wasm unexpectedly imports WASI");
}
const initialized = await init({ module_or_path: module });
if (initialized.memory.buffer instanceof SharedArrayBuffer) {
  throw new Error("browser wasm unexpectedly uses shared memory");
}

if (nativePackageVersion().length === 0) {
  throw new Error("wasm binding version is empty");
}
if (normalizeForSearch("Hello").length === 0) {
  throw new Error("wasm normalization returned an empty result");
}
if (JSON.parse(externalDetectionLimitsJson()).maxDetections !== 100_000) {
  throw new Error("wasm external detection limits diverged");
}

const externalText = "😀Alice signed.";
const externalDocument = new TextEncoder().encode(externalText);
const digest = createHash("sha256").update(externalDocument).digest("hex");
const converted = JSON.parse(
  convertExternalDetectionBatchJson(
    externalDocument,
    JSON.stringify({
      version: 1,
      document: { sha256: digest },
      offsetUnit: "utf16-code-unit",
      provider: { id: "smoke", name: "Smoke", version: "1" },
      labelMap: [{ providerLabel: "PER", entityLabel: "person" }],
      detections: [
        { id: "person-1", start: 2, end: 7, label: "PER", score: 0.99 },
      ],
    }),
  ),
);
if (converted[0]?.start !== 2 || converted[0]?.end !== 7) {
  throw new Error("wasm UTF-16 external detection conversion diverged");
}

const packageBytes = readFileSync(
  join(packageRoot, "native-pipeline.stlanonpkg"),
);
const prepared = WasmPreparedSearch.fromPreparedPackageBytes(packageBytes);
const sample = "A contract was signed by Jan Novak at Praha on 1. 1. 2025.";
const result = JSON.parse(prepared.redactStaticEntitiesJson(sample));
if (result.resolved_entities.length === 0) {
  throw new Error("wasm pipeline found no entities");
}
for (const entity of result.resolved_entities) {
  if (sample.slice(entity.start, entity.end) !== entity.text) {
    throw new Error("wasm entity offsets are not UTF-16 code-unit offsets");
  }
}

const streamEvents = [];
const streamed = prepared.redactStaticEntitiesResultStreamJson(
  sample,
  undefined,
  (eventJson) => streamEvents.push(JSON.parse(eventJson)),
);
const streamedResult = JSON.parse(streamed);
if (
  streamEvents.length === 0 ||
  streamedResult.redaction.redacted_text !== result.redaction.redacted_text ||
  streamedResult.redaction.entity_count !== result.redaction.entity_count
) {
  throw new Error("wasm result stream diverged");
}

const session = prepared.createRedactionSession("wasm_smoke_1");
session.redactStaticEntitiesJson(sample);
const key = new Uint8Array(32).fill(0x42);
const archive = session.toEncryptedArchive(key);
const restored = prepared.restoreEncryptedRedactionSession(
  archive,
  key,
  "wasm_smoke_1",
);
if (restored.mappingCount() !== session.mappingCount()) {
  throw new Error("wasm encrypted session archive diverged");
}

const pdf = readFileSync(
  join(
    packageRoot,
    "..",
    "..",
    "crates",
    "anonymize-pdf-core",
    "tests",
    "fixtures",
    "minimal-text.pdf",
  ),
);
if (JSON.parse(inspectPdfJson(pdf)).pageCount !== 1) {
  throw new Error("wasm PDF inspection diverged");
}

console.log(
  JSON.stringify({
    event: "wasm-binding-smoke",
    ok: true,
    imports: imports.length,
    entities: result.resolved_entities.length,
    streamEvents: streamEvents.length,
  }),
);
