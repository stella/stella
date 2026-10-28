/**
 * Runtime-asset smoke for the API image.
 *
 * The container loads several runtimes and external assets lazily: the native
 * anonymization engine and the QuickJS sandbox WASM from bundle sidecars,
 * compiled YARA rules, worker bundles with their sidecars, OCR models, and the
 * OCR PDF font. apps/api/Dockerfile bundles this entry like the server and
 * runs it in a throwaway stage on top of the runner filesystem; a missing or
 * unloadable dependency fails the image build.
 *
 * Self-contained on purpose: no env module, no DB client. Each probe drives
 * the real loader; the sanctions probe spawns the same worker path used by
 * the API and checks both cold and cached matching.
 */

import { panic } from "better-result";
import path from "node:path";

import {
  isNativeAnonymizeBinding,
  loadNativeAnonymizeBinding,
} from "@stll/anonymize";
import { validateIco } from "@stll/business-registries/ares";
import { RegexSet } from "@stll/regex-set";
import { buildScreeningIndex, DEFAULT_CUTOFF, screen } from "@stll/sanctions";
import { TextSearch } from "@stll/text-search";

import { OCR_LOCAL_MODEL_FILES } from "@/api/lib/document-processing-contract";
import { yaraRuleFileCount, yaraScanner } from "@/api/lib/file-scan/yara";
import {
  loadStampFontLicenses,
  loadStampFonts,
} from "@/api/lib/files/pdf-signing/stamp-font";
import { layoutStampRow } from "@/api/lib/files/pdf-signing/stamp-layout";
import { stampTextCheck } from "@/api/lib/files/pdf-signing/stamp-text";
import { newQuickJsAsyncContext } from "@/api/lib/quickjs-runtime";
import {
  RUNTIME_WORKER_FILES,
  RUNTIME_WORKER_SIDECAR_FILES,
  runtimeOcrPdfFontPath,
  runtimeWorkerDir,
} from "@/api/lib/runtime-worker-path";
import { RTF_MIME_TYPE } from "@/api/mime-types";
import { checkBundledSanctionsMatcher } from "@/api/scripts/image-smoke-sanctions";
import { checkBundledPublicTemplates } from "@/api/scripts/image-smoke-template-packs";

const probe = async (label: string, run: () => Promise<void> | void) => {
  await run();
  console.log(`image-smoke ok: ${label}`);
};

await probe("bundled template packs", async () => {
  await checkBundledPublicTemplates(process.env["TEMPLATE_PACKS_CONTENT_DIR"]);
});

await probe("quickjs sandbox wasm", async () => {
  const context = await newQuickJsAsyncContext();
  const handle = context.unwrapResult(context.evalCode("6 * 7"));
  const value = context.getNumber(handle);
  handle.dispose();
  context.dispose();
  if (value !== 42) {
    panic(`quickjs evaluated 6 * 7 to ${value}`);
  }
});

await probe("yara rules", async () => {
  if (yaraRuleFileCount === 0) {
    panic("no YARA rule files were compiled; rules directory missing?");
  }
  const matches = await yaraScanner.scan(
    new TextEncoder().encode("image smoke probe"),
  );
  if (!Array.isArray(matches)) {
    panic("yara scan returned no match list");
  }
});

await probe("runtime worker bundles", async () => {
  const workerDir =
    runtimeWorkerDir() ??
    panic("STELLA_WORKER_DIR must be set for the image smoke");
  const expected = [
    ...Object.values(RUNTIME_WORKER_FILES),
    ...RUNTIME_WORKER_SIDECAR_FILES,
  ];
  const missing = (
    await Promise.all(
      expected.map(async (file) =>
        (await Bun.file(path.join(workerDir, file)).exists()) ? null : file,
      ),
    )
  ).filter((file) => file !== null);
  if (missing.length > 0) {
    panic(`runtime worker dir is missing: ${missing.join(", ")}`);
  }
});

await probe("sanctions matcher worker", checkBundledSanctionsMatcher);

await probe("ocr pdf font", async () => {
  const fontPath =
    runtimeOcrPdfFontPath() ??
    panic("STELLA_OCR_PDF_FONT_PATH must be set for the image smoke");
  if (!(await Bun.file(fontPath).exists())) {
    panic(`missing OCR PDF font at ${fontPath}`);
  }
});

// Unlike the presence checks above, the local OCR worker is spawned for
// real on a minimal blank-page PDF: it exercises the pdfium wasm, the
// onnxruntime native binding at its bundle-relative location, and the
// pinned models, exactly as a document-processing run would.
await probe("local ocr worker", async () => {
  const workerDir =
    runtimeWorkerDir() ??
    panic("STELLA_WORKER_DIR must be set for the image smoke");
  const modelDir =
    process.env["DOCUMENT_OCR_MODEL_DIR"] ??
    panic("DOCUMENT_OCR_MODEL_DIR must be set for the image smoke");
  const missingModels = (
    await Promise.all(
      Object.values(OCR_LOCAL_MODEL_FILES).map(async (file) =>
        (await Bun.file(path.join(modelDir, file)).exists()) ? null : file,
      ),
    )
  ).filter((file) => file !== null);
  if (missingModels.length > 0) {
    panic(`missing OCR models: ${missingModels.join(", ")}`);
  }

  const blankPagePdf = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj",
    "trailer << /Size 4 /Root 1 0 R >>",
  ].join("\n");
  const subprocess = Bun.spawn(
    [
      "bun",
      "run",
      path.join(workerDir, RUNTIME_WORKER_FILES.ocrLocal),
      modelDir,
    ],
    {
      stdin: new Blob([blankPagePdf]),
      stdout: "pipe",
      stderr: "pipe",
      // A hung worker must fail the image build, not stall it.
      timeout: 120_000,
    },
  );
  const [output, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  if (exitCode !== 0) {
    panic(`local ocr worker exited with ${exitCode}: ${stderr.trim()}`);
  }
  const parsed: unknown = JSON.parse(output);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("pages" in parsed) ||
    !Array.isArray(parsed.pages) ||
    parsed.pages.length !== 1
  ) {
    panic("local ocr worker returned an unexpected result shape");
  }
});

await probe("anonymize native engine", () => {
  const binding = loadNativeAnonymizeBinding();
  if (!isNativeAnonymizeBinding(binding)) {
    panic("anonymize native loader returned an unexpected binding shape");
  }
});

await probe("model ingress script bundle", async () => {
  const subprocess = Bun.spawn(["bun", "/app/image-smoke-model-ingress.js"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
    // The guard's observability imports validate base configuration;
    // this probe never opens a database or storage connection.
    env: {
      ...process.env,
      DATABASE_URL: "postgres://smoke:smoke@localhost:5432/smoke",
      S3_ENDPOINT: "http://localhost",
      S3_BUCKET: "smoke",
      S3_REGION: "eu-central-1",
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  if (exitCode !== 0) {
    panic(`model ingress script exited with ${exitCode}: ${stderr.trim()}`);
  }
  if (stdout.trim() !== "image-smoke ok: model ingress guard") {
    panic("model ingress script did not finish its native matcher probe");
  }
});

// Error fingerprints group by source positions, so the long-running bundles
// must map their frames through the shipped, content-stripped source maps.
// Started without configuration, each fails environment validation; its stack
// must name a source file rather than a bundle offset.
// The case-law runner maps relative to its own package, so its frames read
// /api/src/... rather than /apps/api/src/....
const SOURCE_FRAME = /\/api\/src\/\S+\.ts:\d+:\d+/u;
const LONG_RUNNING_BUNDLES = [
  ["/app/server.js"],
  ["/app/document-processing-worker.js"],
  ["/app/legal-atlas.js", "run", "case-law-ingest", "__smoke__"],
] as const;
for (const [bundle, ...args] of LONG_RUNNING_BUNDLES) {
  await probe(`${bundle} frames map to source`, async () => {
    const subprocess = Bun.spawn(["bun", "--no-env-file", bundle, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
      env: { PATH: process.env["PATH"] ?? "", HOME: "/tmp" },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ]);
    const output = `${stdout}\n${stderr}`;
    if (exitCode === 0 || !output.includes("Invalid environment variables")) {
      panic(`${bundle} did not stop at environment validation: ${output}`);
    }
    if (output.includes("Could not decode sourcemap")) {
      panic(`${bundle} could not decode its source map: ${output}`);
    }
    if (!SOURCE_FRAME.test(output)) {
      panic(`${bundle} printed no source-mapped frame: ${output}`);
    }
  });
}

// Office formats convert through anydoc's native binding inside the extraction
// worker bundle; RTF is the smallest document that takes that path.
await probe("extraction worker anydoc native", async () => {
  const workerDir =
    runtimeWorkerDir() ??
    panic("STELLA_WORKER_DIR must be set for the image smoke");
  const subprocess = Bun.spawn(
    [
      "bun",
      "--no-env-file",
      path.join(workerDir, RUNTIME_WORKER_FILES.extraction),
      RTF_MIME_TYPE,
    ],
    {
      stdin: new Blob(["{\\rtf1\\ansi image smoke anydoc\\par}"]),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  if (exitCode !== 0 || !stdout.includes("image smoke anydoc")) {
    panic(`extraction worker did not convert RTF (${exitCode}): ${stderr}`);
  }
});

// The image is glibc (Debian); a musl build of a native addon can never load
// here. napi-rs loaders reference both builds, so the bundler ships both
// unless the build marks the musl package external.
await probe("no musl native addons", async () => {
  const musl = await Array.fromAsync(
    new Bun.Glob("**/*musl*.node").scan({ cwd: "/app", onlyFiles: true }),
  );
  if (musl.length > 0) {
    panic(
      `musl native addons ship in the glibc image: ${musl.join(", ")}; mark their packages --external in the bundle build`,
    );
  }
});

// The operator scripts build together and share their code through
// /app/chunk-*.js. A script whose `import.meta.main` block lands in a chunk
// loads, does nothing and exits 0. Started without configuration or
// arguments, every script that loads a shared chunk must reach its own
// environment or argument validation and say so. Chunks import each other, so
// only the non-chunk files that import one are scripts.
const SHARED_CHUNK_PREFIX = "chunk-";
const SHARED_CHUNK_IMPORT = `"/app/${SHARED_CHUNK_PREFIX}`;
await probe("every split script runs its main block", async () => {
  const names = await Array.fromAsync(
    new Bun.Glob("*.js").scan({ cwd: "/app", onlyFiles: true }),
  );
  const scripts: string[] = [];
  for (const name of names.toSorted()) {
    if (
      name.startsWith(SHARED_CHUNK_PREFIX) ||
      name.startsWith("image-smoke")
    ) {
      continue;
    }
    const source = await Bun.file(path.join("/app", name)).text();
    if (source.includes(SHARED_CHUNK_IMPORT)) {
      scripts.push(path.join("/app", name));
    }
  }
  if (scripts.length === 0) {
    panic("no script in /app loads a shared chunk; is the split build gone?");
  }
  for (const script of scripts) {
    const subprocess = Bun.spawn(["bun", "--no-env-file", script], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
      env: { PATH: process.env["PATH"] ?? "", HOME: "/tmp" },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ]);
    const output = `${stdout}\n${stderr}`.trim();
    if (subprocess.signalCode !== null) {
      panic(`${script} did not stop within 30 s: ${output}`);
    }
    if (/cannot (?:find|resolve) (?:module|package)/iu.test(output)) {
      panic(`${script} could not load its code: ${output}`);
    }
    if (output === "") {
      panic(
        `${script} exited ${String(subprocess.exitCode)} without output; its main block did not run`,
      );
    }
  }
});

// Exercise RegexSet itself: the literal TextSearch probe selects Aho-Corasick.
await probe("regex-set native binding", () => {
  const search = new RegexSet(["token"]);
  const matches = search.findIter("token token");
  if (
    matches.length !== 2 ||
    matches[0]?.start !== 0 ||
    matches[1]?.start !== 6
  ) {
    panic("regex-set native binding returned incorrect match ranges");
  }
});

// Literal tenant identifier redaction uses Aho-Corasick; both matching and
// replacement must execute through the native binding in the compiled image.
await probe("text-search native binding", () => {
  const tenantId = "12345678-1234-5678-9abc-123456789abc";
  const search = new TextSearch([tenantId], { allLiteral: true });
  const input = `matter ${tenantId}; tenant ${tenantId}`;
  if (!search.isMatch(input)) {
    panic("text-search did not match a tenant identifier");
  }
  if (
    // oxlint-disable-next-line require-function-replacer/require-function-replacer -- TextSearch takes literal replacement arrays, not String replacement syntax.
    search.replaceAll(input, ["[redacted]"]) !==
    "matter [redacted]; tenant [redacted]"
  ) {
    panic("text-search did not redact every tenant identifier");
  }
});

// Registry adapters validate identifiers through the stdnum native binding,
// which loads lazily on first call; a well-formed IČO proves the addon is
// embedded and callable.
await probe("stdnum native binding", () => {
  if (!validateIco("27082440")) {
    panic("stdnum rejected a well-formed identifier");
  }
});

// Sanctions screening scores near names through the fuzzy-search native
// binding; a one-letter spelling variant only matches through an edit
// distance, which proves the addon is embedded and callable.
await probe("sanctions fuzzy-search binding", () => {
  const index = buildScreeningIndex([
    {
      version: { source: "eu", publishedAt: "2026-09-29", fileId: null },
      entries: [
        {
          source: "eu",
          issuer: "EU",
          sourceId: "image-smoke",
          referenceNumber: null,
          entityType: "person",
          names: [{ name: "Jan Novak", quality: "strong" }],
          birthDates: [],
          nationalities: [],
          identifiers: [],
          addresses: [],
          programme: null,
          legalBasis: null,
          listedOn: null,
          sourceUrl: "https://eur-lex.europa.eu/",
        },
      ],
    },
  ]);
  const result = screen(
    index,
    { name: "Jan Novek" },
    { cutoff: DEFAULT_CUTOFF },
  );
  if (result.isErr() || result.value.possibleMatches.length !== 1) {
    panic("sanctions screening did not match a one-letter name variant");
  }
});

// Visible signature stamps draw with embedded fonts and shape with an
// embedded WebAssembly shaper, all carried by the compiled binary as
// assets, together with the fonts' licences.
await probe("signature stamp fonts and shaper", async () => {
  const fonts = await loadStampFonts();
  if (
    !stampTextCheck(fonts).canDraw("Čř \u0645\u062D\u0645\u062F \u6771\u4EAC")
  ) {
    panic("the stamp fonts cannot draw the scripts they are chosen for");
  }
  const row = layoutStampRow({
    direction: "rtl",
    fonts,
    text: "\u0628\u0628\u0628",
  });
  const glyphs = new Set(
    row.runs.flatMap(({ glyphs: shaped }) =>
      shaped.map(({ glyphId }) => glyphId),
    ),
  );
  if (glyphs.size !== 3) {
    panic("the stamp shaper did not join Arabic letters");
  }
  const licenses = await loadStampFontLicenses();
  if (licenses.some((license) => license.length === 0)) {
    panic("a stamp font's licence is missing");
  }
});

console.log("image-smoke ok: all runtime assets loadable");
