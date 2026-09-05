/**
 * Report spec discovery.
 *
 * Specs come from two places, merged by key (the directory name):
 *
 * 1. Bundled defaults under `handlers/reports/builtin/<key>/`, imported per
 *    file (`spec.json` as a JSON module, prompts with `with { type: "file" }`)
 *    so `bun build --compile` embeds them; a directory glob does not survive
 *    the compile (see the note in `builtin-templates.ts`).
 * 2. At runtime, every `<key>/spec.json` with its sibling `prompts/*.md`,
 *    either under the `REPORT_SPECS_DIR` directory or under the
 *    `REPORT_SPECS_S3_PREFIX` object prefix (same layout, read into memory
 *    with per-file and per-prefix ceilings). A runtime key overrides a
 *    bundled one.
 *
 * Every spec is validated with `parseReportSpec` and every `prompt.ref` must
 * resolve; an invalid spec is a boot error, never a per-export failure.
 */

import { panic, Result } from "better-result";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type {
  ReportSection,
  ReportSpec,
} from "@/api/handlers/reports/spec/report-spec";
import { parseReportSpec } from "@/api/handlers/reports/spec/report-spec";
import { ConfigurationError } from "@/api/lib/errors/tagged-errors";

import tableReportExecSummary from "../builtin/table-report/prompts/exec-summary.md" with { type: "file" };
import tableReportSpec from "../builtin/table-report/spec.json" with { type: "json" };

const SPEC_FILENAME = "spec.json";
const PROMPTS_DIRNAME = "prompts";
const PROMPT_EXTENSION = ".md";

/** Ceilings for the object-store source; a prefix past them is a boot error. */
export const MAX_S3_SPECS = 50;
export const MAX_S3_SPEC_FILE_BYTES = 64 * 1024;
export const MAX_S3_PROMPTS_PER_SPEC = 20;
const MAX_S3_OBJECTS = MAX_S3_SPECS * (1 + MAX_S3_PROMPTS_PER_SPEC);
const S3_LOAD_TIMEOUT_MS = 60_000;
/** Object reads in flight at once during the boot load. */
const S3_READ_CONCURRENCY = 8;
const S3_PREFIX_PATTERN =
  /^s3:\/\/(?<bucket>[^/\s]+)\/(?<prefix>(?:[^/\s]+\/)*)$/u;

/** One spec directory before validation: the decoded `spec.json` plus the
 *  prompt texts by ref. */
export type ReportSpecSource = {
  spec: unknown;
  prompts: Map<string, string>;
};

export type LoadedReportSpec = {
  key: string;
  spec: ReportSpec;
  prompts: Map<string, string>;
};

const readText = (filePath: string): string => readFileSync(filePath, "utf-8");

/** The bundled default specs, keyed like their directory. Each file is listed
 *  explicitly so the bundler embeds it. */
export const bundledReportSpecSources = (): Map<string, ReportSpecSource> =>
  new Map([
    [
      "table-report",
      {
        spec: tableReportSpec,
        prompts: new Map([["exec-summary", readText(tableReportExecSummary)]]),
      },
    ],
  ]);

const promptRefs = (sections: ReportSection[]): string[] => {
  const refs: string[] = [];
  for (const section of sections) {
    switch (section.kind) {
      case "narrative":
        if ("ref" in section.prompt) {
          refs.push(section.prompt.ref);
        }
        break;
      case "grouped":
      case "appendix":
        refs.push(...promptRefs(section.children));
        break;
      case "cover":
      case "toc":
      case "page-break":
      case "stats":
      case "findings-table":
      case "findings":
      case "per-contract":
      case "matrix":
        break;
      default: {
        section satisfies never;
        return panic(`Unhandled section: ${String(section)}`);
      }
    }
  }
  return refs;
};

const parseSource = (
  key: string,
  source: ReportSpecSource,
): Result<LoadedReportSpec, ConfigurationError> => {
  const parsed = parseReportSpec(source.spec);
  if (Result.isError(parsed)) {
    return Result.err(
      new ConfigurationError({
        message: `Report spec "${key}": ${parsed.error.message}`,
      }),
    );
  }
  const missing = promptRefs(parsed.value.sections).filter(
    (ref) => !source.prompts.has(ref),
  );
  if (missing.length > 0) {
    return Result.err(
      new ConfigurationError({
        message: `Report spec "${key}": missing prompt file(s) ${missing
          .map((ref) => `${PROMPTS_DIRNAME}/${ref}${PROMPT_EXTENSION}`)
          .join(", ")}.`,
      }),
    );
  }
  return Result.ok({ key, spec: parsed.value, prompts: source.prompts });
};

const readPrompts = (dir: string): Map<string, string> => {
  const promptsDir = path.join(dir, PROMPTS_DIRNAME);
  if (!existsSync(promptsDir)) {
    return new Map();
  }
  const prompts = new Map<string, string>();
  for (const file of readdirSync(promptsDir)) {
    if (path.extname(file) !== PROMPT_EXTENSION) {
      continue;
    }
    prompts.set(
      path.basename(file, PROMPT_EXTENSION),
      readText(path.join(promptsDir, file)),
    );
  }
  return prompts;
};

/** Every `<dir>/spec.json` directly under `specsDir`. */
export const readReportSpecSourcesFromDir = (
  specsDir: string,
): Result<Map<string, ReportSpecSource>, ConfigurationError> => {
  if (!(existsSync(specsDir) && statSync(specsDir).isDirectory())) {
    return Result.err(
      new ConfigurationError({
        message: `REPORT_SPECS_DIR does not point at a directory: ${specsDir}`,
      }),
    );
  }
  const sources = new Map<string, ReportSpecSource>();
  for (const entry of readdirSync(specsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = path.join(specsDir, entry.name);
    const specPath = path.join(dir, SPEC_FILENAME);
    if (!existsSync(specPath)) {
      continue;
    }
    const json = Result.try({
      try: (): unknown => JSON.parse(readText(specPath)),
      catch: (cause) =>
        new ConfigurationError({
          message: `Report spec "${entry.name}": ${SPEC_FILENAME} is not valid JSON.`,
          cause,
        }),
    });
    if (Result.isError(json)) {
      return Result.err(json.error);
    }
    sources.set(entry.name, { spec: json.value, prompts: readPrompts(dir) });
  }
  return Result.ok(sources);
};

// ── Object-store source ──────────────────────────────────────────────────────

export type S3SpecPrefix = { bucket: string; prefix: string };

/** `s3://bucket/prefix/` → parts; the env schema already enforces the shape. */
export const parseS3SpecPrefix = (
  value: string,
): Result<S3SpecPrefix, ConfigurationError> => {
  const groups = S3_PREFIX_PATTERN.exec(value)?.groups;
  if (groups?.["bucket"] === undefined || groups["prefix"] === undefined) {
    return Result.err(
      new ConfigurationError({
        message: `REPORT_SPECS_S3_PREFIX must look like s3://bucket/prefix/ (got ${value}).`,
      }),
    );
  }
  return Result.ok({ bucket: groups["bucket"], prefix: groups["prefix"] });
};

/** The two object-store operations the loader needs; production binds them to
 *  the API's S3 helpers, tests to an in-memory map. */
export type ReportSpecObjectStore = {
  listKeys: (options: {
    bucket: string;
    prefix: string;
    maxKeys: number;
    signal: AbortSignal;
  }) => Promise<string[]>;
  readObject: (options: {
    bucket: string;
    key: string;
    maxBytes: number;
    signal: AbortSignal;
  }) => Promise<Uint8Array>;
};

type S3SpecRead =
  | { kind: "spec"; specKey: string; key: string }
  | { kind: "prompt"; specKey: string; key: string; ref: string };

/** `fn` over `items`, at most `size` in flight at once, results in item order. */
const mapInChunks = async <T, R>(
  items: readonly T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = [];
  const mapFrom = async (index: number): Promise<R[]> => {
    if (index >= items.length) {
      return results;
    }
    const chunk = items.slice(index, index + size);
    results.push(...(await Promise.all(chunk.map(fn))));
    return await mapFrom(index + size);
  };
  return await mapFrom(0);
};

type S3SpecFile =
  | { kind: "spec"; specKey: string }
  | { kind: "prompt"; specKey: string; ref: string };

/** Classify one key relative to the prefix; anything outside the
 *  `<key>/spec.json` and `<key>/prompts/<ref>.md` layout is ignored, like a
 *  stray file in the directory form. */
const classifyS3Key = (relativeKey: string): S3SpecFile | null => {
  const parts = relativeKey.split("/");
  const specKey = parts.at(0);
  if (specKey === undefined || specKey.length === 0) {
    return null;
  }
  if (parts.length === 2 && parts[1] === SPEC_FILENAME) {
    return { kind: "spec", specKey };
  }
  const file = parts.at(2);
  if (
    parts.length === 3 &&
    parts[1] === PROMPTS_DIRNAME &&
    file?.endsWith(PROMPT_EXTENSION)
  ) {
    return {
      kind: "prompt",
      specKey,
      ref: path.basename(file, PROMPT_EXTENSION),
    };
  }
  return null;
};

type ReadS3SpecSourcesOptions = {
  store: ReportSpecObjectStore;
  location: S3SpecPrefix;
  signal?: AbortSignal;
};

/** Every `<key>/spec.json` (plus prompts) under the prefix, read into memory. */
export const readReportSpecSourcesFromS3 = async ({
  store,
  location: { bucket, prefix },
  signal = AbortSignal.timeout(S3_LOAD_TIMEOUT_MS),
}: ReadS3SpecSourcesOptions): Promise<
  Result<Map<string, ReportSpecSource>, ConfigurationError>
> => {
  const listed = await Result.tryPromise({
    try: async () =>
      await store.listKeys({ bucket, prefix, maxKeys: MAX_S3_OBJECTS, signal }),
    catch: (cause) =>
      new ConfigurationError({
        message: `REPORT_SPECS_S3_PREFIX: listing s3://${bucket}/${prefix} failed.`,
        cause,
      }),
  });
  if (Result.isError(listed)) {
    return Result.err(listed.error);
  }
  if (listed.value.length > MAX_S3_OBJECTS) {
    return Result.err(
      new ConfigurationError({
        message: `REPORT_SPECS_S3_PREFIX: more than ${MAX_S3_OBJECTS} objects under s3://${bucket}/${prefix}.`,
      }),
    );
  }

  const specKeys = new Map<string, string>();
  const promptKeys = new Map<string, Map<string, string>>();
  for (const key of listed.value) {
    const file = classifyS3Key(key.slice(prefix.length));
    if (file === null) {
      continue;
    }
    switch (file.kind) {
      case "spec":
        specKeys.set(file.specKey, key);
        break;
      case "prompt": {
        const prompts =
          promptKeys.get(file.specKey) ?? new Map<string, string>();
        prompts.set(file.ref, key);
        if (prompts.size > MAX_S3_PROMPTS_PER_SPEC) {
          return Result.err(
            new ConfigurationError({
              message: `Report spec "${file.specKey}": more than ${MAX_S3_PROMPTS_PER_SPEC} prompt files under s3://${bucket}/${prefix}${file.specKey}/${PROMPTS_DIRNAME}/.`,
            }),
          );
        }
        promptKeys.set(file.specKey, prompts);
        break;
      }
      default: {
        file satisfies never;
        return panic(`Unhandled file: ${String(file)}`);
      }
    }
  }
  if (specKeys.size > MAX_S3_SPECS) {
    return Result.err(
      new ConfigurationError({
        message: `REPORT_SPECS_S3_PREFIX: ${specKeys.size} specs under s3://${bucket}/${prefix}, more than the ${MAX_S3_SPECS} allowed.`,
      }),
    );
  }

  const readObjectText = async (
    specKey: string,
    key: string,
  ): Promise<Result<string, ConfigurationError>> =>
    await Result.tryPromise({
      try: async () =>
        new TextDecoder().decode(
          await store.readObject({
            bucket,
            key,
            maxBytes: MAX_S3_SPEC_FILE_BYTES,
            signal,
          }),
        ),
      catch: (cause) =>
        new ConfigurationError({
          message: `Report spec "${specKey}": reading s3://${bucket}/${key} failed.`,
          cause,
        }),
    });

  // One read per listed object, in listing order (spec.json first, then its
  // prompts), so the first failure reported is the first in that order.
  const reads: S3SpecRead[] = [];
  for (const [specKey, key] of specKeys) {
    reads.push({ kind: "spec", specKey, key });
    // A spec without a prompts directory has no entry here.
    const specPromptKeys = promptKeys.get(specKey);
    if (!specPromptKeys) {
      continue;
    }
    for (const [ref, promptKey] of specPromptKeys) {
      reads.push({ kind: "prompt", specKey, key: promptKey, ref });
    }
  }
  const texts = await mapInChunks(reads, S3_READ_CONCURRENCY, async (read) => ({
    read,
    text: await readObjectText(read.specKey, read.key),
  }));

  const sources = new Map<string, ReportSpecSource>();
  for (const { read, text } of texts) {
    if (Result.isError(text)) {
      return Result.err(text.error);
    }
    switch (read.kind) {
      case "spec": {
        const json = Result.try({
          try: (): unknown => JSON.parse(text.value),
          catch: (cause) =>
            new ConfigurationError({
              message: `Report spec "${read.specKey}": ${SPEC_FILENAME} is not valid JSON.`,
              cause,
            }),
        });
        if (Result.isError(json)) {
          return Result.err(json.error);
        }
        sources.set(read.specKey, { spec: json.value, prompts: new Map() });
        break;
      }
      case "prompt": {
        const source = sources.get(read.specKey);
        if (!source) {
          return panic(
            `Prompt "${read.ref}" read before its spec "${read.specKey}"`,
          );
        }
        source.prompts.set(read.ref, text.value);
        break;
      }
      default: {
        read satisfies never;
        return panic(`Unhandled read: ${String(read)}`);
      }
    }
  }
  return Result.ok(sources);
};

// ── Merge ────────────────────────────────────────────────────────────────────

/** Where runtime specs come from; the env invariant makes the two exclusive. */
export type ReportSpecRuntimeSource =
  | { type: "none" }
  | { type: "dir"; specsDir: string }
  | { type: "s3"; store: ReportSpecObjectStore; location: S3SpecPrefix };

type LoadReportSpecsOptions = {
  bundled: Map<string, ReportSpecSource>;
  runtime: ReportSpecRuntimeSource;
};

const readRuntimeSources = async (
  runtime: ReportSpecRuntimeSource,
): Promise<Result<Map<string, ReportSpecSource>, ConfigurationError>> => {
  switch (runtime.type) {
    case "none":
      return Result.ok(new Map());
    case "dir":
      return readReportSpecSourcesFromDir(runtime.specsDir);
    case "s3":
      return await readReportSpecSourcesFromS3(runtime);
    default: {
      runtime satisfies never;
      return panic(`Unhandled runtime: ${String(runtime)}`);
    }
  }
};

/** Validate and merge bundled + runtime specs; a runtime key wins. */
export const loadReportSpecs = async ({
  bundled,
  runtime,
}: LoadReportSpecsOptions): Promise<
  Result<Map<string, LoadedReportSpec>, ConfigurationError>
> => {
  const sources = new Map(bundled);
  const runtimeSources = await readRuntimeSources(runtime);
  if (Result.isError(runtimeSources)) {
    return Result.err(runtimeSources.error);
  }
  for (const [key, source] of runtimeSources.value) {
    sources.set(key, source);
  }
  const loaded = new Map<string, LoadedReportSpec>();
  for (const [key, source] of sources) {
    const parsed = parseSource(key, source);
    if (Result.isError(parsed)) {
      return Result.err(parsed.error);
    }
    loaded.set(key, parsed.value);
  }
  return Result.ok(loaded);
};
