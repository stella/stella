#!/usr/bin/env node
/**
 * Headless-browser smoke test for the @stll/anonymize-wasm BROWSER path.
 *
 * The Node/Bun smokes exercise the same generated ESM module in server
 * runtimes. This smoke proves its browser path without cross-origin isolation,
 * shared memory, or workers.
 *
 * Architecture:
 *   - A local static HTTP server serves the built `wasm/dist/` directory with
 *     no cross-origin isolation headers.
 *   - A headless Chrome (system binary; see resolveChrome) navigates to the
 *     ordinary document, then dynamically imports the package browser entry
 *     (`/wasm.mjs`) and runs `createPipeline({ language: "en" })` +
 *     `redactText`. The
 *     module's own `import.meta.url` resolves the `native/` glue, wasm binary,
 *     and the `en` compressed package from the same origin.
 *
 * Assumptions / environment:
 *   - The package must be built first: `bun run build` then
 *     `bun run build:wasm-assets` (produces `wasm/dist/wasm.mjs` and
 *     `wasm/dist/native/`).
 *   - A system Chrome/Chromium is available. Locally that is the macOS app; on
 *     GitHub ubuntu runners it is `google-chrome-stable`. Set CHROME_BIN or
 *     PUPPETEER_EXECUTABLE_PATH to override. We use `puppeteer-core` (no bundled
 *     browser download) to keep CI light.
 *   - `--no-sandbox` is passed so the smoke runs as root on CI runners; the
 *     served content is local and trusted.
 *
 * Run: `node scripts/smoke-wasm-browser.mjs` (from packages/anonymize).
 */
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(here);
const distDir = join(packageRoot, "wasm", "dist");
const nativeNodeEntryPath = join(packageRoot, "dist", "native-node.mjs");
const pdfFixturePath = join(
  packageRoot,
  "..",
  "..",
  "crates",
  "anonymize-pdf-core",
  "tests",
  "fixtures",
  "minimal-text.pdf",
);

const SAMPLE = "A contract was signed by Jan Novak at Praha on 1. 1. 2025.";
const EXTERNAL_DETECTION_DOCUMENT = "😀Alice signed.";
// Hard ceiling so a hung browser cannot exceed the CI budget.
const OVERALL_TIMEOUT_MS = 90_000;
const EVAL_TIMEOUT_MS = 45_000;

const startedAt = Date.now();
const mark = (phase) =>
  process.stderr.write(`[smoke] ${phase} +${Date.now() - startedAt}ms\n`);

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".cjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".stlanonpkg", "application/octet-stream"],
]);

const INDEX_HTML =
  '<!doctype html><html><head><meta charset="utf-8">' +
  "<title>anonymize-wasm browser smoke</title></head><body></body></html>";

const requireBuilt = () => {
  const entry = join(distDir, "wasm.mjs");
  const enPackage = join(distDir, "native", "native-pipeline.en.stlanonpkg");
  for (const [label, path] of [
    ["package entry", entry],
    ["native Node entry", nativeNodeEntryPath],
    ["en compressed package", enPackage],
  ]) {
    if (!existsSync(path)) {
      throw new Error(
        `Missing ${label}: ${path}. Run "bun run build" then "bun run build:wasm-assets".`,
      );
    }
  }
};

/** Locate a system Chrome/Chromium. Prefers explicit env overrides, then the
 * well-known macOS and Linux install paths. */
const resolveChrome = () => {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "No system Chrome/Chromium found. Set CHROME_BIN or " +
      "PUPPETEER_EXECUTABLE_PATH to a Chrome binary.",
  );
};

/** Static file server for `wasm/dist/` without isolation headers. */
const startServer = () =>
  new Promise((resolve) => {
    const server = createServer((request, response) => {
      const urlPath = decodeURIComponent((request.url ?? "/").split("?")[0]);
      if (urlPath === "/") {
        response.setHeader("Content-Type", CONTENT_TYPES.get(".html"));
        response.end(INDEX_HTML);
        return;
      }
      // Resolve inside distDir and reject traversal outside it. The trailing
      // separator prevents prefix bypass via sibling dirs (e.g. dist-other).
      const filePath = normalize(join(distDir, urlPath));
      if (!filePath.startsWith(distDir + sep) || !existsSync(filePath)) {
        response.statusCode = 404;
        response.end("not found");
        return;
      }
      const type =
        CONTENT_TYPES.get(extname(filePath)) ?? "application/octet-stream";
      response.setHeader("Content-Type", type);
      response.end(readFileSync(filePath));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

/** Runs inside an ordinary page, rejects shared memory and worker creation,
 * loads the browser entry, redacts, and hands a compact result back to Node. */
const runInPage = async ({ sample, externalDetectionDocument, pdfBase64 }) => {
  if (self.crossOriginIsolated !== false) {
    throw new Error("browser smoke unexpectedly has cross-origin isolation");
  }
  const NativeMemory = WebAssembly.Memory;
  Object.defineProperty(WebAssembly, "Memory", {
    configurable: true,
    value: class NonSharedMemory extends NativeMemory {
      constructor(descriptor) {
        if (descriptor.shared === true) {
          throw new Error(
            "browser binding requested shared WebAssembly memory",
          );
        }
        super(descriptor);
      }
    },
  });
  Object.defineProperty(self, "Worker", {
    configurable: true,
    value: class ForbiddenWorker {
      constructor() {
        throw new Error("browser binding attempted to create a worker");
      }
    },
  });
  const rawModule = await import("/native/index.js");
  const initialized = await rawModule.default({
    module_or_path: new URL("/native/index_bg.wasm", location.href),
  });
  const SharedBuffer = globalThis.SharedArrayBuffer;
  const memoryBuffer = initialized.memory.buffer;
  const sharedMemory =
    (typeof SharedBuffer === "function" &&
      memoryBuffer instanceof SharedBuffer) ||
    Object.prototype.toString.call(memoryBuffer) ===
      "[object SharedArrayBuffer]";
  if (sharedMemory) {
    throw new Error("browser binding uses shared WebAssembly memory");
  }
  const module = await import("/wasm.mjs");
  const expectedExternalLimits = {
    batchMaxBytes: 16_777_216,
    documentMaxBytes: 67_108_864,
    maxDetections: 100_000,
    maxLabelMappings: 4_096,
    maxMetadataBytes: 256,
    providerIdMaxBytes: 128,
  };
  const actualExternalLimits = {
    batchMaxBytes: module.EXTERNAL_DETECTION_BATCH_MAX_BYTES,
    documentMaxBytes: module.EXTERNAL_DETECTION_DOCUMENT_MAX_BYTES,
    maxDetections: module.EXTERNAL_DETECTION_MAX_DETECTIONS,
    maxLabelMappings: module.EXTERNAL_DETECTION_MAX_LABEL_MAPPINGS,
    maxMetadataBytes: module.EXTERNAL_DETECTION_MAX_METADATA_BYTES,
    providerIdMaxBytes: module.EXTERNAL_DETECTION_PROVIDER_ID_MAX_BYTES,
  };
  if (
    JSON.stringify(actualExternalLimits) !==
    JSON.stringify(expectedExternalLimits)
  ) {
    throw new Error("browser external detection limits diverged");
  }
  const externalDocument = new TextEncoder().encode(externalDetectionDocument);
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", externalDocument)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const externalBatch = (offsetUnit, start, end) => ({
    version: module.EXTERNAL_DETECTION_BATCH_VERSION,
    document: { sha256: digest },
    offsetUnit,
    provider: {
      id: "browser-fake-provider",
      name: "Browser fake provider",
      version: "1",
    },
    labelMap: [{ providerLabel: "PER", entityLabel: "person" }],
    detections: [{ id: "person-1", start, end, label: "PER", score: 0.99 }],
  });
  const externalDetectionResults = [];
  for (const [offsetUnit, start, end] of [
    ["utf8-byte", 4, 9],
    ["utf16-code-unit", 2, 7],
    ["unicode-code-point", 1, 6],
  ]) {
    externalDetectionResults.push(
      await module.convert_external_detection_batch(
        externalDocument,
        externalBatch(offsetUnit, start, end),
      ),
    );
  }
  const rejectionCases = [
    [externalBatch("utf8-byte", 1, 9), "valid text boundary"],
    [externalBatch("utf16-code-unit", 1, 7), "valid text boundary"],
    [
      {
        ...externalBatch("unicode-code-point", 1, 6),
        document: { sha256: "0".repeat(64) },
      },
      "document.sha256 does not match input bytes",
    ],
    [
      JSON.stringify({
        ...externalBatch("unicode-code-point", 1, 6),
        legacyOffsetGuessing: true,
      }),
      "unknown field `legacyOffsetGuessing`",
    ],
  ];
  const externalDetectionRejections = [];
  for (const [batch, expectedError] of rejectionCases) {
    try {
      await module.convert_external_detection_batch(externalDocument, batch);
      externalDetectionRejections.push(false);
    } catch (error) {
      externalDetectionRejections.push(
        error instanceof Error && error.message.includes(expectedError),
      );
    }
  }
  const pipeline = await module.createPipeline({ language: "en" });
  const result = pipeline.redactText(sample);
  const session = pipeline.createRedactionSession("browser_archive_smoke_1");
  session.redactText(sample);
  const key = new Uint8Array(32).fill(0x42);
  const archive = session.toEncryptedArchive(key);
  const restoredSession = pipeline.restoreEncryptedRedactionSession({
    archive,
    key,
    expectedSessionId: "browser_archive_smoke_1",
  });
  const pdfBytes = Uint8Array.from(atob(pdfBase64), (character) =>
    character.charCodeAt(0),
  );
  const pdfInspectionJson = await module.inspect_pdf_json(pdfBytes);
  let pdfError;
  try {
    await module.inspect_pdf_json(new Uint8Array([0]));
  } catch (error) {
    pdfError = String(error?.message ?? error);
  }
  return {
    singleThread: !sharedMemory,
    entities: result.resolvedEntities.map(({ start, end, text, label }) => ({
      start,
      end,
      text,
      label,
    })),
    redactedText: result.redaction.redactedText,
    archiveByteLength: archive.byteLength,
    restoredSessionId: restoredSession.sessionId(),
    restoredMappingCount: restoredSession.mappingCount(),
    externalDetectionResults,
    externalDetectionRejections,
    pdfInspectionJson,
    pdfError,
  };
};

const validate = (result, expectedPdfJson, expectedPdfError) => {
  const {
    singleThread,
    entities,
    redactedText,
    archiveByteLength,
    restoredSessionId,
    restoredMappingCount,
    externalDetectionResults,
    externalDetectionRejections,
    pdfInspectionJson,
    pdfError,
  } = result;
  if (singleThread !== true) {
    throw new Error("browser binding did not prove single-thread memory");
  }
  const expectedExternalDetection = [
    {
      start: 2,
      end: 7,
      label: "person",
      score: 0.99,
      providerId: "browser-fake-provider",
      detectionId: "person-1",
    },
  ];
  if (
    externalDetectionResults.length !== 3 ||
    externalDetectionResults.some(
      (detections) =>
        JSON.stringify(detections) !==
        JSON.stringify(expectedExternalDetection),
    )
  ) {
    throw new Error("browser external detection offset conversion diverged");
  }
  if (
    externalDetectionRejections.length !== 4 ||
    externalDetectionRejections.some((rejected) => !rejected)
  ) {
    throw new Error("browser external detection contract did not fail closed");
  }
  if (!Array.isArray(entities) || entities.length === 0) {
    throw new Error("browser pipeline did not detect any entity");
  }
  for (const { start, end, text, label } of entities) {
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end <= start ||
      end > SAMPLE.length ||
      // Offsets are UTF-16 code units, so a JS slice must round-trip the text.
      SAMPLE.slice(start, end) !== text
    ) {
      throw new Error(
        `entity offsets do not round-trip: ${label} [${start}, ${end}) => ` +
          `"${SAMPLE.slice(start, end)}" != "${text}"`,
      );
    }
  }
  if (redactedText === SAMPLE) {
    throw new Error("redaction did not change the text");
  }
  if (
    archiveByteLength <= 0 ||
    restoredSessionId !== "browser_archive_smoke_1" ||
    restoredMappingCount <= 0
  ) {
    throw new Error("browser encrypted session archive did not round-trip");
  }
  if (pdfInspectionJson !== expectedPdfJson || pdfError !== expectedPdfError) {
    throw new Error("browser-WASM PDF inspection success/error parity differs");
  }
};

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      );
    }),
  ]);

const main = async () => {
  requireBuilt();
  // eslint-disable-next-line stll/no-dynamic-import-specifier
  const nativeNodeEntry = await import(pathToFileURL(nativeNodeEntryPath).href);
  const nodeBinding = nativeNodeEntry.loadNativeAnonymizeBinding();
  const pdfBytes = new Uint8Array(readFileSync(pdfFixturePath));
  const expectedPdfJson = nodeBinding.inspectPdfJson(pdfBytes);
  let expectedPdfError;
  try {
    nodeBinding.inspectPdfJson(new Uint8Array([0]));
  } catch (error) {
    expectedPdfError = String(error?.message ?? error);
  }
  if (!expectedPdfError) {
    throw new Error("native Node PDF inspection did not reject invalid bytes");
  }
  const executablePath = resolveChrome();
  const server = await startServer();
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  mark("server-listening");
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    timeout: EVAL_TIMEOUT_MS,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  mark("browser-launched");

  const consoleErrors = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error) => consoleErrors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });

    await page.goto(origin, { waitUntil: "load", timeout: EVAL_TIMEOUT_MS });
    mark("page-loaded");
    const result = await withTimeout(
      page.evaluate(runInPage, {
        sample: SAMPLE,
        externalDetectionDocument: EXTERNAL_DETECTION_DOCUMENT,
        pdfBase64: Buffer.from(pdfBytes).toString("base64"),
      }),
      EVAL_TIMEOUT_MS,
      "page redaction",
    );
    mark("redaction-done");
    validate(result, expectedPdfJson, expectedPdfError);

    console.log(
      JSON.stringify({
        event: "wasm-browser-smoke",
        ok: true,
        chrome: executablePath,
        crossOriginIsolated: false,
        singleThread: result.singleThread,
        entityCount: result.entities.length,
        encryptedSessionArchive: true,
        pdfInspectionParity: true,
        labels: result.entities.map((entity) => entity.label),
        firstEntity: {
          start: result.entities[0].start,
          end: result.entities[0].end,
          label: result.entities[0].label,
        },
      }),
    );
  } catch (error) {
    if (consoleErrors.length > 0) {
      console.error("browser console errors:\n  " + consoleErrors.join("\n  "));
    }
    throw error;
  } finally {
    mark("closing");
    const process_ = browser.process();
    await withTimeout(browser.close(), 5_000, "browser close").catch(() => {
      process_?.kill("SIGKILL");
    });
    server.close();
    mark("closed");
  }
};

await withTimeout(main(), OVERALL_TIMEOUT_MS, "browser smoke")
  // A force-killed browser can leave puppeteer transport handles open, keeping
  // the event loop alive. Exit explicitly once the assertions have passed.
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(String(error?.stack ?? error));
    process.exit(1);
  });
