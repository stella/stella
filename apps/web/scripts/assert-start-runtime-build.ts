import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  referencedAssetPath,
  resolveSourceWorkerEntry,
  SOURCE_WORKER_FILE_GLOB,
  workerSourceSpecifiers,
} from "./runtime-asset-contracts";

const WEB_ROOT_URL = new URL("../", import.meta.url);
const WEB_ROOT_PATH = fileURLToPath(WEB_ROOT_URL);

type RuntimeAssetContract = {
  expectedCount: number;
  label: string;
  pattern: string;
  sourceEntry?: string;
};

// Every emitted worker/WASM asset must belong to this total registry. The
// source-entry check below derives first-party worker entries from application
// code, while the emitted-asset check rejects unregistered dependency workers
// and WASM sidecars. A new runtime asset therefore cannot silently bypass the
// production build contract.
const RUNTIME_ASSET_CONTRACTS = [
  {
    expectedCount: 1,
    label: "PDF.js worker",
    pattern: "dist/client/assets/pdfjs-worker-????????.js",
    sourceEntry: "src/lib/pdf/pdfjs-worker.ts",
  },
  {
    expectedCount: 1,
    label: "PDF search worker",
    pattern: "dist/client/assets/pdf-search-worker-????????.js",
    sourceEntry: "src/workers/pdf-search-worker.ts",
  },
  {
    expectedCount: 1,
    label: "PDF page editor worker",
    pattern: "dist/client/assets/pdf-page-editor-worker-????????.js",
    sourceEntry: "src/workers/pdf-page-editor-worker.ts",
  },
  {
    expectedCount: 1,
    label: "chat anonymization worker",
    pattern: "dist/client/assets/anonymize-chat-worker-????????.js",
    sourceEntry: "src/workers/anonymize-chat-worker.ts",
  },
  {
    expectedCount: 2,
    label: "Office render worker hosts",
    pattern: "dist/client/assets/render-worker-host-*.js",
  },
  {
    expectedCount: 2,
    label: "Office render workers",
    pattern: "dist/client/assets/render-worker-????????-????????.js",
  },
  {
    expectedCount: 1,
    label: "Office font metrics worker",
    pattern: "dist/client/assets/font-metrics.worker-????????.js",
  },
  {
    expectedCount: 1,
    label: "XLSX parser WASM",
    pattern: "dist/client/assets/xlsx_parser_bg-????????.wasm",
  },
  {
    expectedCount: 1,
    label: "PPTX parser WASM",
    pattern: "dist/client/assets/pptx_parser_bg-????????.wasm",
  },
  {
    expectedCount: 1,
    // @vscode/diff (the markdown editor's baseline diff) loads its binary via
    // `new URL(..., import.meta.url)`, so Vite emits it as a hashed asset.
    label: "markdown editor diff WASM",
    pattern: "dist/client/assets/diff_wasm_bg-*.wasm",
  },
  {
    expectedCount: 1,
    label: "anonymization WASM glue",
    pattern: "dist/client/native/index.js",
  },
  {
    expectedCount: 1,
    label: "anonymization WASM binary",
    pattern: "dist/client/native/index_bg.wasm",
  },
] as const satisfies readonly RuntimeAssetContract[];

const hasPDFWorkerFallbackContract = (
  value: unknown,
): value is {
  WorkerMessageHandler: { setup: (...args: unknown[]) => unknown };
} => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("WorkerMessageHandler" in value)) {
    return false;
  }
  const handler = value.WorkerMessageHandler;
  return (
    typeof handler === "function" &&
    "setup" in handler &&
    typeof handler.setup === "function"
  );
};

const isNonEmptyFile = async (relativePath: string): Promise<boolean> => {
  const file = Bun.file(new URL(relativePath, WEB_ROOT_URL));
  return (await file.exists()) && file.size > 0;
};

const discoverSourceWorkerEntries = async (): Promise<Set<string>> => {
  const sourceFiles = new Bun.Glob(SOURCE_WORKER_FILE_GLOB);
  const entries = new Set<string>();

  for await (const sourcePath of sourceFiles.scan({ cwd: WEB_ROOT_PATH })) {
    const sourceUrl = new URL(sourcePath, WEB_ROOT_URL);
    const source = await Bun.file(sourceUrl).text();
    for (const specifier of workerSourceSpecifiers(source)) {
      // oxlint-disable-next-line no-await-in-loop -- ordered source discovery resolves extensionless Vite imports against the filesystem
      const entry = await resolveSourceWorkerEntry(specifier, sourceUrl);
      if (entry !== undefined) {
        entries.add(entry);
      }
    }
  }

  return entries;
};

const assetReferencePatterns = [
  /(?:from\s*|import\s*\(\s*|import\s*)["'`]([^"'`]+)["'`]/gu,
  /new URL\(\s*(["'`])([^"'`]+)\1\s*,[^)]{0,64}import\.meta\.url\s*\)/gu,
] as const;

const requiredFiles = [
  "dist/runtime.js",
  "dist/server/server.js",
  "dist/client/prepaint-init.js",
] as const;
const contractErrors: string[] = [];

const requiredFileChecks = await Promise.all(
  requiredFiles.map(async (requiredFile) => ({
    exists: await isNonEmptyFile(requiredFile),
    requiredFile,
  })),
);
for (const { exists, requiredFile } of requiredFileChecks) {
  if (!exists) {
    contractErrors.push(`missing or empty ${requiredFile}`);
  }
}

const clientAssetGlob = new Bun.Glob("dist/client/assets/*");
const firstClientAsset = await clientAssetGlob
  .scan({ cwd: WEB_ROOT_PATH })
  .next();
if (firstClientAsset.done) {
  contractErrors.push("missing dist/client/assets/*");
}

const discoveredSourceEntries = await discoverSourceWorkerEntries();
const declaredSourceEntries = new Set<string>(
  RUNTIME_ASSET_CONTRACTS.flatMap((contract) =>
    "sourceEntry" in contract ? [contract.sourceEntry] : [],
  ),
);
for (const entry of discoveredSourceEntries) {
  if (!declaredSourceEntries.has(entry)) {
    contractErrors.push(`worker source has no runtime contract: ${entry}`);
  }
}
for (const entry of declaredSourceEntries) {
  if (!discoveredSourceEntries.has(entry)) {
    contractErrors.push(`runtime contract has no worker source: ${entry}`);
  }
}

const claimedRuntimeAssets = new Set<string>();
const contractAssets = new Map<string, readonly string[]>();
const matchedContracts = await Promise.all(
  RUNTIME_ASSET_CONTRACTS.map(async (contract) => ({
    contract,
    matches: await Array.fromAsync(
      new Bun.Glob(contract.pattern).scan({ cwd: WEB_ROOT_PATH }),
    ),
  })),
);
for (const { contract, matches } of matchedContracts) {
  contractAssets.set(contract.label, matches);
  if (matches.length !== contract.expectedCount) {
    contractErrors.push(
      `${contract.label} expected ${contract.expectedCount} asset(s), found ${matches.length}: ${contract.pattern}`,
    );
  }
  for (const match of matches) {
    claimedRuntimeAssets.add(match);
  }
}
const claimedAssetChecks = await Promise.all(
  matchedContracts.flatMap(({ contract, matches }) =>
    matches.map(async (match) => ({
      contract,
      exists: await isNonEmptyFile(match),
      match,
    })),
  ),
);
for (const { contract, exists, match } of claimedAssetChecks) {
  if (!exists) {
    contractErrors.push(`${contract.label} is empty: ${match}`);
  }
}

const emittedFiles = await Array.fromAsync(
  new Bun.Glob("dist/client/**/*").scan({ cwd: WEB_ROOT_PATH }),
);
const emittedRuntimeAssets = emittedFiles.filter((emittedPath) => {
  if (emittedPath.endsWith(".wasm")) {
    return true;
  }
  const fileName = path.basename(emittedPath);
  return (
    emittedPath.endsWith(".js") &&
    fileName.includes("worker") &&
    !fileName.includes("worker-client")
  );
});
for (const emittedPath of emittedRuntimeAssets) {
  if (!claimedRuntimeAssets.has(emittedPath)) {
    contractErrors.push(`emitted runtime asset is unclaimed: ${emittedPath}`);
  }
}

const emittedJavaScript = emittedFiles.filter((emittedPath) =>
  emittedPath.endsWith(".js"),
);
const emittedJavaScriptSources = await Promise.all(
  emittedJavaScript.map(async (emittedPath) => ({
    emittedPath,
    source: await Bun.file(new URL(emittedPath, WEB_ROOT_URL)).text(),
  })),
);
const assetReferences = new Map<string, string>();
for (const { emittedPath, source } of emittedJavaScriptSources) {
  for (const pattern of assetReferencePatterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const reference = match.at(-1);
      if (reference === undefined) {
        continue;
      }
      const targetPath = referencedAssetPath(emittedPath, reference);
      if (targetPath) {
        assetReferences.set(targetPath, emittedPath);
      }
    }
  }
}
const assetReferenceChecks = await Promise.all(
  [...assetReferences].map(async ([targetPath, emittedPath]) => ({
    emittedPath,
    exists: await isNonEmptyFile(targetPath),
    targetPath,
  })),
);
for (const { emittedPath, exists, targetPath } of assetReferenceChecks) {
  if (!exists) {
    contractErrors.push(
      `${emittedPath} references missing or empty ${targetPath}`,
    );
  }
}

const pdfWorkerAsset = contractAssets.get("PDF.js worker")?.at(0);
if (pdfWorkerAsset !== undefined) {
  const workerModule: unknown = await import(
    new URL(pdfWorkerAsset, WEB_ROOT_URL).href
  );
  if (!hasPDFWorkerFallbackContract(workerModule)) {
    contractErrors.push(
      `${pdfWorkerAsset} does not export WorkerMessageHandler.setup`,
    );
  }
}

const anonymizationWorkerAsset = contractAssets
  .get("chat anonymization worker")
  ?.at(0);
if (anonymizationWorkerAsset !== undefined) {
  const source = await Bun.file(
    new URL(anonymizationWorkerAsset, WEB_ROOT_URL),
  ).text();
  if (!source.includes("/native/index.js")) {
    contractErrors.push(
      `${anonymizationWorkerAsset} does not anchor its runtime at /native/index.js`,
    );
  }
}

if (contractErrors.length > 0) {
  console.error(
    [
      "TanStack Start runtime build contract failed.",
      "The deploy pipeline expects a complete, loadable production asset graph.",
      ...contractErrors.map((error) => `Invalid: ${error}`),
    ].join("\n"),
  );
  process.exit(1);
}
