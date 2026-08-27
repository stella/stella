/* @stll/anonymize-wasm — browser / WebAssembly entry.
 *
 * Exposes the same native-SDK surface as `@stll/anonymize/native` (the
 * runtime-agnostic layer in `native.ts`), backed by a browser-native,
 * single-thread wasm-bindgen module instead of the `.node` sidecars. The old
 * TS-pipeline surface (`runPipeline` and friends) is intentionally gone here:
 * this package now redacts entirely through the wasm binding and PREBUILT
 * prepared packages.
 *
 * Browsers can either load prepared packages (pass package bytes, an
 * `ArrayBuffer`, or a URL to fetch, or call `loadDefaultPipeline()` for the
 * default package bundled in the tarball) or build a config in-browser: the
 * wasm binding exposes the same static-search config assembly the Node
 * binding does, so `prepareNativePipelineConfig` / `createNativePipelineFromConfig`
 * / `prepareNativePipelinePackage` work here too.
 *
 * No module-level side effects: the wasm binding is instantiated lazily on
 * first use via `getBinding()`. The wasm-bindgen glue is loaded from the
 * package's own `native/` asset directory. It has no WASI, shared-memory, or
 * worker dependency.
 */

import {
  createNativeAnonymizerFromPackage,
  createNativePipelineFromPackage,
  isNativeAnonymizeBinding,
  convert_external_detection_batch as convertExternalDetectionBatchWithBinding,
  diagnostics_json as diagnosticsJsonWithBinding,
  diagnostics_stream_json as diagnosticsStreamJsonWithBinding,
  type NativeAnonymizeBinding,
  type ExternalDetectionBatch,
  type NativeCallerDetection,
  type NativeDiagnosticsBatchCallback,
  type NativeOperatorConfig,
  type NativeResultEventCallback,
  type NativeSearchPackageInput,
  type NativeStaticRedactionResult,
  native_package_version as nativePackageVersionWithBinding,
  normalize_for_search as normalizeForSearchWithBinding,
  PreparedNativeAnonymizer,
  PreparedNativePipeline,
  prepare_search_package as prepareSearchPackageWithBinding,
  redact_text as redactTextWithBinding,
  redact_text_json as redactTextJsonWithBinding,
  redact_text_stream_json as redactTextStreamJsonWithBinding,
  summary_diagnostics_json as summaryDiagnosticsJsonWithBinding,
} from "./native";
import { createWasmBinding, isRawWasmModule } from "./wasm-binding";
import { createSemanticPipeline } from "./create-pipeline";
import {
  normalizePipelineLanguageSelection,
  type PipelineLanguageSelection,
} from "./pipeline-language";

export * from "./native";
export { deanonymise, exportRedactionKey } from "./redact";
export {
  CAPABILITY_MANIFEST,
  CAPABILITY_MANIFEST_SCHEMA_VERSION,
  CAPABILITY_PARITY_PROFILES,
  CAPABILITY_RUNTIMES,
  CAPABILITY_SURFACES,
} from "./capabilities";
export type {
  CapabilityManifest,
  CapabilityParityProfile,
  CapabilityRuntime,
  CapabilitySurface,
  CapabilitySurfaceId,
} from "./capabilities";
export {
  DEFAULT_ENTITY_LABELS,
  DETECTION_SOURCES,
  DETECTOR_PRIORITY,
  ENTITY_CAPABILITIES,
  ENTITY_LABELS,
  ENTITY_SELECTIONS,
  OPERATOR_TYPES,
} from "./types";
export type {
  AnonymisationOperator,
  DetectionSource,
  Dictionaries,
  DefaultEntityLabel,
  Entity,
  EntityCapability,
  EntityLabel,
  EntitySelection,
  GazetteerEntry,
  OperatorConfig,
  OperatorType,
  PipelineConfig,
  RedactionResult,
  ReviewDecision,
  ReviewedEntity,
} from "./types";
export { SUPPORTED_LANGUAGES } from "./pipeline-language";
export type {
  PipelineLanguageSelection,
  SupportedLanguage,
} from "./pipeline-language";
// Config-driven pipeline surface: pure TS that delegates to
// `binding.assembleStaticSearchConfigJson` / `assembleStaticSearchPackageBytes`,
// which the wasm binding exposes with no cfg gating (crates/anonymize-napi/src/lib.rs),
// so browser callers can assemble packages from a `PipelineConfig` (e.g. live
// gazetteer entries and dictionaries) instead of only loading prebuilt packages.
export {
  assertNativePipelineSupported,
  createNativePipelineFromConfig,
  getNativePipelineCompatibility,
  prepareNativePipelineConfig,
  prepareNativePipelinePackage,
} from "./native-pipeline";
export type {
  NativePipelineBuildOptions,
  NativePipelineCompatibility,
  NativePipelinePackageOptions,
  NativePipelineUnsupportedFeature,
} from "./native-pipeline";
export { createPipelineContext } from "./context";
export type { PipelineContext } from "./context";

/** A prepared package the caller supplies: raw bytes, an ArrayBuffer, or a URL
 * (string or `URL`) that resolves to the package and is fetched. */
export type PreparedPackageSource = Uint8Array | ArrayBuffer | URL | string;

/** Escape hatch for callers that already hold a binding (e.g. a custom sidecar
 * or a test double). When omitted, the lazily-instantiated wasm binding is
 * used. */
export type WasmBindingOptions = {
  binding?: NativeAnonymizeBinding;
};

const GLUE_MODULE = "index.js";
const WASM_MODULE = "index_bg.wasm";
const NODE_FS_MODULE = "node:fs/promises";
const NATIVE_ASSET_DIR = "native";
const ASSET_DIR_ENV = "STLL_ANONYMIZE_ASSET_DIR";
const DEFAULT_PACKAGE_FILE = "native-pipeline.stlanonpkg";
const LANGUAGE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const HTML_MEDIA_TYPES = new Set(["application/xhtml+xml", "text/html"]);
const DEFAULT_PIPELINE_CACHE_KEY = "<default>";
// Bounds `defaultPipelineCache` to a small, fixed number of prepared
// pipelines: without a cap, a caller that varies `language` (e.g. many
// unrecognized tags that all fall back to the same bundled package, see
// `defaultPipelineCacheKey`) grows this cache — and the prepared pipelines it
// holds — without limit.
const DEFAULT_PIPELINE_CACHE_MAX_ENTRIES = 32;

let bindingPromise: Promise<NativeAnonymizeBinding> | undefined;
const defaultPipelineCache = new Map<string, Promise<PreparedNativePipeline>>();
const unavailablePackageUrls = new Set<string>();

class PreparedPackageUnavailableError extends Error {
  constructor(href: string, options?: ErrorOptions) {
    super(`Prepared package is unavailable: ${href}`, options);
    this.name = "PreparedPackageUnavailableError";
  }
}

/** Instantiate (once) and return the wasm binding. Safe to call repeatedly:
 * the underlying wasm module is instantiated a single time and cached. */
export const getBinding = (): Promise<NativeAnonymizeBinding> => {
  bindingPromise ??= loadWasmBinding();
  return bindingPromise;
};

const loadWasmBinding = async (): Promise<NativeAnonymizeBinding> => {
  const glueUrl = assetUrl(GLUE_MODULE);
  // eslint-disable-next-line stll/no-dynamic-import-specifier
  const loaded: unknown = await import(/* @vite-ignore */ glueUrl.href);
  if (!isRawWasmModule(loaded)) {
    throw new Error("wasm module does not expose the expected binding surface");
  }
  const moduleInput = isNodeRuntime()
    ? await readFileUrlBytes(assetUrl(WASM_MODULE).href)
    : assetUrl(WASM_MODULE);
  await loaded.default({ module_or_path: moduleInput });
  return createWasmBinding(loaded);
};

type RuntimeGlobals = {
  process?: {
    env?: Record<string, string | undefined>;
    versions?: { node?: string };
  };
  window?: unknown;
};

const isNodeRuntime = (): boolean => {
  const globals: RuntimeGlobals = globalThis;
  return (
    globals.window === undefined &&
    typeof globals.process?.versions?.node === "string"
  );
};

/**
 * `STLL_ANONYMIZE_ASSET_DIR` overrides the native-asset base for
 * single-binary deployments (e.g. `bun build --compile`): there
 * `import.meta.url` points into the binary's embedded filesystem, which
 * dynamic `import()` never escapes, so relative resolution cannot reach
 * assets installed on disk. Point the override at a real directory holding
 * the contents of `dist/native/`; it accepts an absolute POSIX path or a
 * `file:` URL. Browsers never define `process`, so the override is inert
 * there.
 */
const assetDirOverrideUrl = (): URL | undefined => {
  const globals: RuntimeGlobals = globalThis;
  const override = globals.process?.env?.[ASSET_DIR_ENV];
  if (override === undefined || override === "") {
    return undefined;
  }
  if (override.startsWith("file:")) {
    return new URL(override.endsWith("/") ? override : `${override}/`);
  }
  if (!override.startsWith("/")) {
    throw new Error(
      `${ASSET_DIR_ENV} must be an absolute path or a file: URL, got ${JSON.stringify(override)}`,
    );
  }
  // pathToFileURL semantics without importing node:url (this module also
  // ships to browsers): encode each segment so characters like `#`, `?`,
  // and `%` stay path data instead of URL syntax.
  const encoded = override.split("/").map(encodeURIComponent).join("/");
  return new URL(`file://${encoded.endsWith("/") ? encoded : `${encoded}/`}`);
};

/**
 * Base URL the native assets (glue module, wasm, prepared packages) resolve
 * against: the override when set, otherwise the `native/` directory next to
 * this module. The default stays a single verbatim expression — the Vite
 * plugin (vite.ts) anchors on its exact emitted text to re-point browser
 * builds at emitted assets.
 */
const assetBaseUrl = (): URL =>
  assetDirOverrideUrl() ?? new URL(`./${NATIVE_ASSET_DIR}/`, import.meta.url);

const assetUrl = (fileName: string): URL => new URL(fileName, assetBaseUrl());

const resolveBinding = (
  options?: WasmBindingOptions,
): Promise<NativeAnonymizeBinding> =>
  options?.binding
    ? Promise.resolve(toNativeAnonymizeBinding(options.binding))
    : getBinding();

const toPackageBytes = async (
  source: PreparedPackageSource,
): Promise<Uint8Array> => {
  if (source instanceof Uint8Array) {
    return source;
  }
  if (source instanceof ArrayBuffer) {
    return new Uint8Array(source);
  }
  const href = source instanceof URL ? source.href : source;
  // Node's global fetch (undici) rejects file: URLs, so package URLs resolved
  // from import.meta.url (loadDefaultPipeline, `new URL(..., import.meta.url)`)
  // fail there. Read those through node:fs instead of fetch.
  if (href.startsWith("file:")) {
    try {
      return await readFileUrlBytes(href);
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new PreparedPackageUnavailableError(href, { cause: error });
      }
      throw error;
    }
  }
  const response = await fetch(href);
  if (!response.ok) {
    if (response.status === 404) {
      throw new PreparedPackageUnavailableError(href);
    }
    throw new Error(
      `Failed to fetch prepared package (${response.status} ${response.statusText})`,
    );
  }
  if (isHtmlResponse(response)) {
    throw new PreparedPackageUnavailableError(href);
  }
  return new Uint8Array(await response.arrayBuffer());
};

const isHtmlResponse = (response: Response): boolean => {
  const contentType = response.headers.get("content-type");
  if (contentType === null) {
    return false;
  }
  const mediaType = contentType.split(";", 1).at(0)?.trim().toLowerCase();
  return mediaType !== undefined && HTML_MEDIA_TYPES.has(mediaType);
};

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

/** Read a `file:` URL through node:fs. The import is dynamic and gated behind
 * the `file:` check (never reached in browsers); the specifier is a runtime
 * value so the bundler leaves it alone, mirroring the runtime glue import in
 * {@link loadWasmBinding}, so browser bundles never pull in node:fs. */
const readFileUrlBytes = async (fileUrl: string): Promise<Uint8Array> => {
  // eslint-disable-next-line stll/no-dynamic-import-specifier
  const { readFile } = await import(/* @vite-ignore */ NODE_FS_MODULE);
  return new Uint8Array(await readFile(new URL(fileUrl)));
};

// --- Prepared-package loaders (the primary browser flow) ---------------------

export type LoadPreparedPackageOptions = WasmBindingOptions;

export type CreatePipelineOptions = WasmBindingOptions & {
  language?: PipelineLanguageSelection;
};

/** Load a prepared package and return a pipeline ready to redact text. */
export const loadPipeline = async (
  source: PreparedPackageSource,
  options?: LoadPreparedPackageOptions,
): Promise<PreparedNativePipeline> => {
  const [binding, packageBytes] = await Promise.all([
    resolveBinding(options),
    toPackageBytes(source),
  ]);
  return createNativePipelineFromPackage({ binding, packageBytes });
};

/** Load a prepared package and return the lower-level anonymizer. */
export const load_prepared_package = async (
  source: PreparedPackageSource,
  options?: LoadPreparedPackageOptions,
): Promise<PreparedNativeAnonymizer> => {
  const [binding, packageBytes] = await Promise.all([
    resolveBinding(options),
    toPackageBytes(source),
  ]);
  return createNativeAnonymizerFromPackage({ binding, packageBytes });
};

// --- Default package bundled in the tarball ----------------------------------

/** URL of a bundled default prepared package, resolved against this module so
 * it points at the `native/` asset directory shipped in the tarball. */
export const defaultPackageUrl = (language?: string): URL =>
  language === undefined
    ? assetUrl(DEFAULT_PACKAGE_FILE)
    : assetUrl(`native-pipeline.${normalizeLanguage(language)}.stlanonpkg`);

/** Load a fresh pipeline from the bundled default prepared package.
 *
 * Mirrors the node loader's regional-tag fallback: when an exact package for
 * a locale tag such as `en-US` is not shipped, the base-language package
 * (`en`) is loaded instead. The browser cannot check asset existence up
 * front, so the fallback triggers on a failed load of the exact package. */
export const loadDefaultPipeline = async (
  language?: string,
  options?: LoadPreparedPackageOptions,
): Promise<PreparedNativePipeline> => {
  try {
    return await loadPipeline(defaultPackageUrl(language), options);
  } catch (error) {
    if (!(error instanceof PreparedPackageUnavailableError)) {
      throw error;
    }
    const normalized =
      language === undefined ? undefined : normalizeLanguage(language);
    const baseLanguage = normalized?.split("-").at(0);
    if (baseLanguage === undefined || baseLanguage === normalized) {
      throw error;
    }
    return loadPipeline(defaultPackageUrl(baseLanguage), options);
  }
};

/** Normalized cache key for {@link defaultPipelineCache}: `undefined` maps to
 * the bundled-default sentinel, everything else goes through the same
 * {@link normalizeLanguage} helper `loadDefaultPipeline`/`defaultPackageUrl`
 * already validate against, so aliases that differ only by case or whitespace
 * (e.g. `"EN"` vs `"en"`) share one cached pipeline instead of each minting
 * their own. */
const defaultPipelineCacheKey = (language: string | undefined): string =>
  language === undefined
    ? DEFAULT_PIPELINE_CACHE_KEY
    : normalizeLanguage(language);

/** Record `key` as most-recently-used in {@link defaultPipelineCache},
 * evicting the least-recently-used entry first once the cache is at
 * capacity. A `Map`'s insertion order doubles as recency order here: touching
 * an existing key deletes then re-sets it to move it to the end, and
 * eviction drops the first (oldest) key. */
const touchDefaultPipelineCacheEntry = (
  key: string,
  pipeline: Promise<PreparedNativePipeline>,
): void => {
  defaultPipelineCache.delete(key);
  if (defaultPipelineCache.size >= DEFAULT_PIPELINE_CACHE_MAX_ENTRIES) {
    const oldestKey = defaultPipelineCache.keys().next().value;
    if (oldestKey !== undefined) {
      defaultPipelineCache.delete(oldestKey);
    }
  }
  defaultPipelineCache.set(key, pipeline);
};

/** Cached variant of {@link loadDefaultPipeline}: the default pipeline for a
 * given language is fetched and prepared once, then reused.
 *
 * Only the ambient-binding case is cached. The cache key is language-only, so a
 * caller that injects its own `options.binding` bypasses the cache entirely:
 * reusing a pipeline built against a different binding would be wrong, and
 * folding the binding into the key would keep unbounded per-binding entries
 * alive. Injected-binding callers get a fresh pipeline each call. */
export const getDefaultPipeline = (
  language?: string,
  options?: LoadPreparedPackageOptions,
): Promise<PreparedNativePipeline> => {
  if (options?.binding) {
    return loadDefaultPipeline(language, options);
  }
  let key: string;
  try {
    key = defaultPipelineCacheKey(language);
  } catch (error) {
    // normalizeLanguage() validates the tag; surface an invalid language as a
    // rejection like the rest of this async surface, not a synchronous throw
    // (this function isn't declared `async`, so an uncaught throw here would
    // escape synchronously instead of rejecting the returned promise).
    return Promise.reject(error);
  }
  const cached = defaultPipelineCache.get(key);
  if (cached !== undefined) {
    touchDefaultPipelineCacheEntry(key, cached);
    return cached;
  }
  // Evict the entry on rejection so a failed load (e.g. a transient fetch/read
  // error) is retried on the next call instead of caching the rejection.
  const pipeline = loadDefaultPipeline(language).catch((error: unknown) => {
    defaultPipelineCache.delete(key);
    throw error;
  });
  touchDefaultPipelineCacheEntry(key, pipeline);
  return pipeline;
};

export const createPipeline = async ({
  language,
  ...bindingOptions
}: CreatePipelineOptions = {}): Promise<PreparedNativePipeline> => {
  const selection = normalizePipelineLanguageSelection(language);
  if (selection.type === "all") {
    const packageUrl = defaultPackageUrl();
    if (!unavailablePackageUrls.has(packageUrl.href)) {
      try {
        return await getDefaultPipeline(undefined, bindingOptions);
      } catch (error) {
        if (!(error instanceof PreparedPackageUnavailableError)) {
          throw error;
        }
        unavailablePackageUrls.add(packageUrl.href);
      }
    }
    return createSemanticPipeline({
      binding: await resolveBinding(bindingOptions),
      selection,
    });
  }
  const [singleLanguage, ...additionalLanguages] = selection.languages;
  if (additionalLanguages.length === 0) {
    const packageUrl = defaultPackageUrl(singleLanguage);
    if (!unavailablePackageUrls.has(packageUrl.href)) {
      try {
        return await getDefaultPipeline(singleLanguage, bindingOptions);
      } catch (error) {
        if (!(error instanceof PreparedPackageUnavailableError)) {
          throw error;
        }
        unavailablePackageUrls.add(packageUrl.href);
      }
    }
  }
  return createSemanticPipeline({
    binding: await resolveBinding(bindingOptions),
    selection,
  });
};

export const create_pipeline = createPipeline;

export const redactDefaultText = async (
  fullText: string,
  operators?: NativeOperatorConfig,
  language?: string,
): Promise<NativeStaticRedactionResult> =>
  (await getDefaultPipeline(language)).redactText(fullText, operators);

export const redactDefaultTextJson = async (
  fullText: string,
  operators?: NativeOperatorConfig,
  language?: string,
): Promise<string> =>
  (await getDefaultPipeline(language)).redact_text_json(fullText, operators);

// --- Binding-injected SDK surface (async parity with native-node) ------------

export const native_package_version = async (
  options?: WasmBindingOptions,
): Promise<string> =>
  nativePackageVersionWithBinding(await resolveBinding(options));

export const convert_external_detection_batch = async (
  document: Uint8Array,
  batch: ExternalDetectionBatch | string,
  options?: WasmBindingOptions,
): Promise<NativeCallerDetection[]> =>
  convertExternalDetectionBatchWithBinding({
    binding: await resolveBinding(options),
    document,
    batch,
  });

export const normalize_for_search = async (
  text: string,
  options?: WasmBindingOptions,
): Promise<string> =>
  normalizeForSearchWithBinding({
    binding: await resolveBinding(options),
    text,
  });

export type PrepareSearchPackageOptions = WasmBindingOptions & {
  compressed?: boolean;
};

export const prepare_search_package = async (
  config: NativeSearchPackageInput,
  { compressed = false, ...options }: PrepareSearchPackageOptions = {},
): Promise<Uint8Array> =>
  prepareSearchPackageWithBinding({
    binding: await resolveBinding(options),
    config,
    compressed,
  });

export const redact_text = async (
  config: NativeSearchPackageInput,
  fullText: string,
  operators?: NativeOperatorConfig,
  options?: WasmBindingOptions,
): Promise<NativeStaticRedactionResult> =>
  redactTextWithBinding({
    binding: await resolveBinding(options),
    config,
    fullText,
    ...(operators !== undefined ? { operators } : {}),
  });

export const redact_text_json = async (
  config: NativeSearchPackageInput,
  fullText: string,
  operators?: NativeOperatorConfig,
  options?: WasmBindingOptions,
): Promise<string> =>
  redactTextJsonWithBinding({
    binding: await resolveBinding(options),
    config,
    fullText,
    ...(operators !== undefined ? { operators } : {}),
  });

export const redact_text_stream_json = async (
  config: NativeSearchPackageInput,
  fullText: string,
  onEvent: NativeResultEventCallback,
  operators?: NativeOperatorConfig,
  options?: WasmBindingOptions,
): Promise<string> =>
  redactTextStreamJsonWithBinding({
    binding: await resolveBinding(options),
    config,
    fullText,
    onEvent,
    ...(operators !== undefined ? { operators } : {}),
  });

export const diagnostics_json = async (
  config: NativeSearchPackageInput,
  fullText: string,
  operators?: NativeOperatorConfig,
  options?: WasmBindingOptions,
): Promise<string> =>
  diagnosticsJsonWithBinding({
    binding: await resolveBinding(options),
    config,
    fullText,
    ...(operators !== undefined ? { operators } : {}),
  });

export const diagnostics_stream_json = async (
  config: NativeSearchPackageInput,
  fullText: string,
  onBatch: NativeDiagnosticsBatchCallback,
  operators?: NativeOperatorConfig,
  options?: WasmBindingOptions,
): Promise<string> =>
  diagnosticsStreamJsonWithBinding({
    binding: await resolveBinding(options),
    config,
    fullText,
    onBatch,
    ...(operators !== undefined ? { operators } : {}),
  });

export const summary_diagnostics_json = async (
  config: NativeSearchPackageInput,
  fullText: string,
  operators?: NativeOperatorConfig,
  options?: WasmBindingOptions,
): Promise<string> =>
  summaryDiagnosticsJsonWithBinding({
    binding: await resolveBinding(options),
    config,
    fullText,
    ...(operators !== undefined ? { operators } : {}),
  });

/** Inspect PDF bytes and optional renderer observations through the same
 * fail-closed core used by Node and Python. This does not redact the PDF. */
export const inspect_pdf_json = async (
  document: Uint8Array,
  observationsJson?: string,
  options?: WasmBindingOptions,
): Promise<string> =>
  (await resolveBinding(options)).inspectPdfJson(document, observationsJson);

// --- Binding extraction ------------------------------------------------------

const toNativeAnonymizeBinding = (loaded: unknown): NativeAnonymizeBinding => {
  const candidate = pickBindingCandidate(loaded);
  if (!isNativeAnonymizeBinding(candidate)) {
    throw new Error(
      "wasm binding module does not expose the native anonymize surface",
    );
  }
  return candidate;
};

const pickBindingCandidate = (loaded: unknown): unknown => {
  if (isRecord(loaded) && isNativeAnonymizeBinding(loaded["default"])) {
    return loaded["default"];
  }
  return loaded;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  (typeof value === "object" && value !== null) || typeof value === "function";

const normalizeLanguage = (language: string): string => {
  const normalized = language.trim().toLowerCase();
  if (!LANGUAGE_PATTERN.test(normalized)) {
    throw new Error(`Language must match ${LANGUAGE_PATTERN.source}`);
  }
  return normalized;
};
