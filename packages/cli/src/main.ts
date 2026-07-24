import { realpathSync } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import type {
  deanonymise,
  Dictionaries,
  exportRedactionKey,
  NativeAnonymizeBinding,
  NativeOperatorConfig,
  NativePipelineBuildOptions,
  OperatorType,
  PipelineConfig,
  PreparedNativePipeline,
} from "@stll/anonymize";
import { CAPABILITY_MANIFEST } from "@stll/anonymize/capabilities";
import {
  DEFAULT_ENTITY_LABELS,
  ENTITY_LABELS,
  type EntityLabel,
} from "@stll/anonymize/constants";

import pkg from "../package.json" with { type: "json" };

import {
  AnonymizeSurfaceError,
  exitCodeForError,
  isAnonymizeSurfaceError,
} from "@stll/anonymize/agent-surface";
import { preloadNativeBinding } from "@stll/anonymize/native-runtime";

import type { CliOptions } from "./args";
import {
  DEFAULT_THRESHOLD,
  HELP,
  parseCliArgs,
  parseCountries,
  UsageError,
} from "./args";
import { runFeedbackCommand } from "./feedback";
import type { DictionaryScope } from "./dictionary-scope";
import {
  type DocxCliPipeline,
  type DocxPipelineRequest,
  runDocxCommand,
} from "./docx";
import {
  type PdfCliPipeline,
  type PdfPipelineRequest,
  runPdfCommand,
} from "./pdf";

/**
 * The pipeline functions the CLI needs, backed by the
 * @stll/anonymize native SDK: a binding loader and the
 * config-to-pipeline builder, plus the redaction-key
 * helpers used by the deanonymise path.
 */
export type AnonymizeApi = {
  deanonymise: typeof deanonymise;
  exportRedactionKey: typeof exportRedactionKey;
  createNativePipelineFromConfig: (
    options: NativePipelineBuildOptions,
  ) => Promise<NativeCliPipeline>;
  loadNativeAnonymizeBinding: () => NativeAnonymizeBinding;
};

/**
 * Everything an entry point injects: the pipeline engine
 * and the dictionary source (the @stll/anonymize-data
 * package for the npm bin).
 */
export type CliEngine = {
  api: AnonymizeApi;
  loadDictionaries: (scope: DictionaryScope) => Promise<Dictionaries>;
};

// Statically imported so the version is baked into both
// the npm bundle and the compiled binary; a runtime
// package.json lookup would fail inside the binary's
// virtual filesystem.
const cliVersion = (): string => pkg.version;

/**
 * Filesystem identity of a path: realpath when it exists
 * (so symlinks to the same file compare equal), lexical
 * resolution otherwise (the file may not exist yet).
 */
const canonicalPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

const readStdin = async (): Promise<string> => {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
};

type NamedInput = {
  /** Source path, or null when reading stdin. */
  path: string | null;
  text: string;
};

const readInputs = async (files: string[]): Promise<NamedInput[]> => {
  if (files.length === 0) {
    if (process.stdin.isTTY) {
      throw new UsageError(
        "no input files and stdin is a terminal (see --help)",
      );
    }
    return [{ path: null, text: await readStdin() }];
  }
  return Promise.all(
    files.map(async (path) => ({ path, text: await readFile(path, "utf8") })),
  );
};

/**
 * One file to anonymize in a batch run: the source path to
 * read and the path, relative to the output directory, to
 * write. For a plain file argument the relative path is the
 * basename; for a directory argument the input tree is
 * mirrored, so it is the path relative to that directory.
 */
type FileJob = {
  path: string;
  outputRelative: string;
};

/** Result of expanding the positional arguments into concrete
 * files. `batch` is true when the output must be a directory:
 * more than one file, or any directory argument. */
type ExpandedInputs = {
  jobs: FileJob[];
  batch: boolean;
  /** Likely-binary files skipped during directory walks. */
  skipped: number;
};

// Sniff window for the binary check. A regular text file never
// contains a NUL byte; binaries (images, archives) reliably do.
const TEXT_SNIFF_BYTES = 8192;

/**
 * True when the file's first {@link TEXT_SNIFF_BYTES} bytes
 * contain no NUL byte. Used to skip binaries discovered by a
 * directory walk without reading the whole file.
 */
const looksTextual = async (path: string): Promise<boolean> => {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(TEXT_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, TEXT_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).indexOf(0) === -1;
  } finally {
    await handle.close();
  }
};

/**
 * Collect regular files under `root`, sorted for deterministic
 * order. Symlinks are skipped (avoids cycles and escaping the
 * tree); subdirectories are descended only when `recursive`.
 */
const walkDirectory = async (
  root: string,
  recursive: boolean,
  excludeDir?: string,
): Promise<string[]> => {
  const found: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).toSorted(
      (a, b) => a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Never descend into the output tree: rerunning with --output inside
        // the input directory must not ingest previously generated files.
        if (excludeDir !== undefined && resolve(full) === excludeDir) continue;
        if (recursive) await visit(full);
      } else if (entry.isFile()) {
        found.push(full);
      }
    }
  };
  await visit(root);
  return found;
};

/**
 * Expand positional arguments into concrete file jobs. A file
 * argument becomes one job (always processed); a directory is
 * walked, mirroring its tree into the output and skipping
 * likely-binary files.
 */
const expandInputs = async (
  files: readonly string[],
  recursive: boolean,
  outputDir?: string,
): Promise<ExpandedInputs> => {
  const excludeDir = outputDir === undefined ? undefined : resolve(outputDir);
  const jobs: FileJob[] = [];
  let hasDirectory = false;
  let skipped = 0;
  for (const path of files) {
    // A stat failure (missing path, permission error) is not
    // fatal here: treat it as a file job so the read failure is
    // reported per file. A single such job stays single-input
    // and surfaces the error as a runtime exit; in a batch it is
    // counted as a failed file.
    let stats: Awaited<ReturnType<typeof stat>> | undefined;
    try {
      stats = await stat(path);
    } catch {
      jobs.push({ path, outputRelative: basename(path) });
      continue;
    }
    if (!stats.isDirectory()) {
      jobs.push({ path, outputRelative: basename(path) });
      continue;
    }
    hasDirectory = true;
    for (const file of await walkDirectory(path, recursive, excludeDir)) {
      // A file that disappears or turns unreadable mid-walk is queued anyway:
      // the per-file worker try/catch counts it as failed without aborting
      // the batch. Only a successful sniff that says "binary" skips it.
      const textual = await looksTextual(file).catch(() => true);
      if (!textual) {
        skipped += 1;
        continue;
      }
      jobs.push({ path: file, outputRelative: relative(path, file) });
    }
  }
  return { jobs, batch: hasDirectory || jobs.length > 1, skipped };
};

/**
 * Run `task` over `items` with at most `workers` in flight.
 * The shared native pipeline makes each redaction a synchronous
 * native call, so concurrency here only overlaps async file
 * I/O; the increments below are safe without locking because
 * no `await` sits between the read and the write of `next`.
 */
const runPool = async <T>(
  items: readonly T[],
  workers: number,
  task: (item: T) => Promise<void>,
): Promise<void> => {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      // SAFETY: index < items.length checked above.
      await task(items[index] as T);
    }
  };
  const count = Math.max(1, Math.min(workers, items.length));
  await Promise.all(Array.from({ length: count }, worker));
};

type CliEntity = {
  start: number;
  end: number;
  label: string;
  text: string;
  score: number;
  source: string;
};

type CliRedactionResult = {
  redactedText: string;
  redactionMap: Map<string, string>;
  operatorMap: Map<string, OperatorType>;
  entityCount: number;
};

type NativeCliPipeline = DocxCliPipeline & {
  warmLazyRegex?: () => void;
  redactTextWithCallerDetections: PreparedNativePipeline["redactTextWithCallerDetections"];
  redactText: (
    fullText: string,
    operators?: NativeOperatorConfig,
  ) => {
    resolvedEntities: CliEntity[];
    redaction: CliRedactionResult;
  };
};

// Short aliases for the canonical multi-word labels so that
// `--labels person,email,iban` works without quoting the space
// in "email address". Separator-insensitive resolution (below)
// additionally accepts hyphen/underscore forms such as
// "credit-card-number".
const LABEL_ALIASES: Record<string, EntityLabel> = {
  email: "email address",
  phone: "phone number",
  org: "organization",
  organisation: "organization",
  dob: "date of birth",
  ssn: "social security number",
  "tax id": "tax identification number",
  passport: "passport number",
  "credit card": "credit card number",
  "national id": "national identification number",
};

const LABEL_SEPARATOR_RE = /[\s_-]+/g;
const ENTITY_LABEL_SET: ReadonlySet<string> = new Set(ENTITY_LABELS);

const isEntityLabel = (label: string): label is EntityLabel =>
  ENTITY_LABEL_SET.has(label);

/**
 * Resolve a user-supplied label token to a canonical label.
 * Lowercases and collapses separators, then maps known short
 * aliases. Unknown tokens are returned normalized so the
 * caller can report them verbatim.
 */
const canonicalizeLabel = (raw: string): string => {
  const normalized = raw.toLowerCase().replace(LABEL_SEPARATOR_RE, " ").trim();
  const known: readonly string[] = ENTITY_LABELS;
  if (known.includes(normalized)) {
    return normalized;
  }
  return LABEL_ALIASES[normalized] ?? normalized;
};

const validateLabels = (labels: readonly string[]): EntityLabel[] => {
  const resolved = [...new Set(labels.map(canonicalizeLabel))];
  const valid: EntityLabel[] = [];
  const availableLabels = ENTITY_LABELS.join(", ");
  const availableAliases = Object.keys(LABEL_ALIASES).join(", ");
  for (const label of resolved) {
    if (!isEntityLabel(label)) {
      throw new UsageError(
        [
          "--labels: unknown label",
          JSON.stringify(label) + ";",
          "available:",
          availableLabels,
          "(aliases:",
          availableAliases + ")",
        ].join(" "),
      );
    }
    valid.push(label);
  }
  return valid;
};

type PipelineConfigOptions = Pick<
  CliOptions,
  "countries" | "labels" | "languages" | "threshold"
>;

const buildPipelineConfig = async (
  opts: PipelineConfigOptions,
  loadDictionaries: CliEngine["loadDictionaries"],
): Promise<PipelineConfig> => {
  const dictionaries = await loadDictionaries({
    languages: opts.languages,
    countries: opts.countries,
  });
  return {
    threshold: opts.threshold,
    enableTriggerPhrases: true,
    enableRegex: true,
    enableLegalForms: true,
    enableNameCorpus: true,
    ...(opts.languages === undefined
      ? {}
      : { nameCorpusLanguages: [...opts.languages] }),
    enableDenyList: true,
    ...(opts.countries === undefined
      ? {}
      : { denyListCountries: [...opts.countries] }),
    enableGazetteer: false,
    enableCountries: true,
    enableConfidenceBoost: true,
    enableCoreference: true,
    enableZoneClassification: true,
    enableHotwordRules: true,
    labels:
      opts.labels === undefined
        ? [...DEFAULT_ENTITY_LABELS]
        : validateLabels(opts.labels),
    workspaceId: "cli",
    dictionaries,
  };
};

const buildOperatorConfig = (opts: CliOptions): NativeOperatorConfig => {
  const operators: NonNullable<NativeOperatorConfig["operators"]> = {};
  if (opts.mode === "redact") {
    const labels =
      opts.labels === undefined
        ? DEFAULT_ENTITY_LABELS
        : validateLabels(opts.labels);
    for (const label of labels) operators[label] = "redact";
  }
  return { operators, redactString: opts.redactString };
};

const writeOutput = async (
  path: string | undefined,
  content: string,
): Promise<void> => {
  if (path === undefined) {
    process.stdout.write(content);
    return;
  }
  await writeFile(path, content, "utf8");
};

type RedactionKeyFile = {
  entries: Record<string, { original: string; operator: string }>;
};

const parseRedactionKey = (raw: string): Map<string, string> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError("redaction key is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || !("entries" in parsed)) {
    throw new UsageError(
      'redaction key must be an object with an "entries" field',
    );
  }
  const { entries } = parsed as RedactionKeyFile;
  if (
    typeof entries !== "object" ||
    entries === null ||
    Array.isArray(entries)
  ) {
    throw new UsageError('redaction key "entries" must be an object');
  }
  const map = new Map<string, string>();
  for (const [placeholder, entry] of Object.entries(entries)) {
    if (typeof entry?.original !== "string") {
      throw new UsageError(
        `redaction key entry "${placeholder}" has no original text`,
      );
    }
    map.set(placeholder, entry.original);
  }
  return map;
};

/**
 * Restrict a redaction key to the entities named by --revert.
 * Each token matches a placeholder ("[PERSON_1]") or an original
 * value ("Jan Novák"), case-sensitive and exact. A token that
 * matches nothing is a usage error listing the placeholders the
 * key does define, so the caller can correct the spelling.
 */
const selectRevertEntries = (
  redactionMap: ReadonlyMap<string, string>,
  tokens: readonly string[],
): Map<string, string> => {
  const selected = new Map<string, string>();
  for (const token of tokens) {
    let matched = false;
    for (const [placeholder, original] of redactionMap) {
      if (placeholder === token || original === token) {
        selected.set(placeholder, original);
        matched = true;
      }
    }
    if (!matched) {
      const MAX_LISTED_PLACEHOLDERS = 20;
      const placeholders = [...redactionMap.keys()];
      const listed = placeholders.slice(0, MAX_LISTED_PLACEHOLDERS).join(", ");
      const rest = placeholders.length - MAX_LISTED_PLACEHOLDERS;
      const suffix = rest > 0 ? ` and ${rest} more` : "";
      throw new UsageError(
        `--revert ${JSON.stringify(token)} matched no placeholder or ` +
          `original; available placeholders: ${listed}${suffix}`,
      );
    }
  }
  return selected;
};

/**
 * Ask for a country scope when running interactively on
 * files with no scope flags. Skipped for piped stdin so
 * the CLI stays scriptable.
 */
export const shouldPromptForScope = (
  opts: CliOptions,
  tty: { stdinIsTTY: boolean; stderrIsTTY: boolean },
): boolean =>
  opts.countries === undefined &&
  opts.languages === undefined &&
  !opts.quiet &&
  opts.files.length > 0 &&
  tty.stdinIsTTY &&
  tty.stderrIsTTY;

const promptForCountries = async (): Promise<string[] | undefined> => {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await rl.question(
      "Country scope (ISO codes like CZ,DE,GB; Enter loads all): ",
    );
    const trimmed = answer.trim();
    return trimmed === "" ? undefined : parseCountries(trimmed);
  } finally {
    rl.close();
  }
};

const runDeanonymise = async (
  opts: CliOptions,
  api: AnonymizeApi,
): Promise<void> => {
  if (opts.keyPath !== undefined) {
    throw new UsageError("--key cannot be combined with --deanonymise");
  }
  const keyPath = opts.deanonymiseKeyPath;
  if (keyPath === undefined) throw new UsageError("missing redaction key path");
  const fullMap = parseRedactionKey(await readFile(keyPath, "utf8"));

  // --revert restores a chosen subset; leaving the rest of the
  // key out means deanonymise skips those placeholders, so the
  // other entities stay redacted.
  const redactionMap =
    opts.revert === undefined
      ? fullMap
      : selectRevertEntries(fullMap, opts.revert);

  const inputs = await readInputs(opts.files);
  if (inputs.length > 1) {
    throw new UsageError("--deanonymise accepts a single input");
  }
  const input = inputs[0];
  if (!input) throw new UsageError("no input to deanonymise");
  if (opts.output !== undefined) {
    guardWriteTargets(input.path === null ? [] : [input.path], [
      { path: opts.output, flag: "--output" },
    ]);
  }
  await writeOutput(opts.output, api.deanonymise(input.text, redactionMap));
};

/**
 * Reject any write target (output or key file) whose
 * filesystem identity collides with an input file or with
 * another write target. Symlinks count as collisions.
 */
const guardWriteTargets = (
  inputPaths: readonly string[],
  writeTargets: readonly { path: string; flag: string }[],
): void => {
  const inputs = new Set(inputPaths.map(canonicalPath));
  const seen = new Map<string, string>();
  for (const target of writeTargets) {
    const canonical = canonicalPath(target.path);
    if (inputs.has(canonical)) {
      throw new UsageError(
        `refusing to overwrite input file "${target.path}" (${target.flag})`,
      );
    }
    const clash = seen.get(canonical);
    if (clash !== undefined) {
      throw new UsageError(
        `${target.flag} "${target.path}" collides with ${clash}`,
      );
    }
    seen.set(canonical, `${target.flag} "${target.path}"`);
  }
};

const summarize = (entities: readonly CliEntity[]): string => {
  const counts = new Map<string, number>();
  for (const entity of entities) {
    counts.set(entity.label, (counts.get(entity.label) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .map(([label, count]) => `${label}: ${count}`);
  return parts.length > 0 ? parts.join(", ") : "none";
};

/**
 * A single unit of anonymize work: the text to process, where
 * to write it (undefined means stdout), and a label for the
 * stderr summary. Used by the stdin and single-file flows,
 * which additionally support --json and --key.
 */
type SingleInput = {
  text: string;
  outputPath: string | undefined;
  source: string;
};

const runAnonymiseSingle = async (
  opts: CliOptions,
  runtime: CliRuntime,
  api: AnonymizeApi,
  input: SingleInput,
): Promise<void> => {
  const { entities, redaction } = await runtime.redact(
    input.text,
    buildOperatorConfig(opts),
  );

  if (opts.json) {
    // In redact mode the user chose irreversibility, so the
    // JSON must not carry any detected text. Whitelist the
    // non-sensitive metadata fields; this drops `text` and a
    // coref alias's `corefSourceText`. Offsets index the
    // caller's own input and are kept.
    const jsonEntities =
      opts.mode === "redact"
        ? entities.map(({ start, end, label, score, source }) => ({
            start,
            end,
            label,
            score,
            source,
          }))
        : entities;
    const payload = {
      entityCount: redaction.entityCount,
      entities: jsonEntities,
      redactedText: redaction.redactedText,
    };
    await writeOutput(
      input.outputPath,
      `${JSON.stringify(payload, null, 2)}\n`,
    );
  } else {
    await writeOutput(input.outputPath, redaction.redactedText);
  }

  if (opts.keyPath !== undefined) {
    await writeFile(
      opts.keyPath,
      api.exportRedactionKey(redaction.redactionMap, redaction.operatorMap),
      "utf8",
    );
  }

  if (!opts.quiet) {
    process.stderr.write(
      `anonymize: ${input.source}: ${summarize(entities)}\n`,
    );
  }
};

/** Tally of a batch run for the closing summary line. */
type BatchOutcome = { processed: number; failed: number };

const runAnonymiseBatch = async (
  opts: CliOptions,
  runtime: CliRuntime,
  output: string,
  jobs: readonly FileJob[],
  skipped: number,
): Promise<void> => {
  await mkdir(output, { recursive: true });
  const operatorConfig = buildOperatorConfig(opts);
  const outcome: BatchOutcome = { processed: 0, failed: 0 };

  await runPool(jobs, opts.workers, async (job) => {
    const outputPath = join(output, job.outputRelative);
    try {
      const text = await readFile(job.path, "utf8");
      const { entities, redaction } = await runtime.redact(
        text,
        operatorConfig,
      );
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, redaction.redactedText, "utf8");
      // No await between here and the increment: safe on the
      // single JS thread despite concurrent workers.
      outcome.processed += 1;
      if (!opts.quiet) {
        process.stderr.write(
          `anonymize: ${job.path}: ${summarize(entities)}\n`,
        );
      }
    } catch (err) {
      outcome.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`anonymize: ${job.path}: error: ${message}\n`);
    }
  });

  if (!opts.quiet) {
    const parts = [
      `${outcome.processed} processed`,
      `${outcome.failed} failed`,
    ];
    if (skipped > 0) parts.push(`${skipped} skipped`);
    process.stderr.write(`anonymize: ${parts.join(", ")}\n`);
  }
  // Any per-file failure is a nonzero exit, but the whole batch
  // still runs so one bad file does not hide the rest.
  if (outcome.failed > 0) process.exitCode = 1;
};

const runAnonymise = async (
  opts: CliOptions,
  { api, loadDictionaries }: CliEngine,
): Promise<void> => {
  if (opts.keyPath !== undefined && opts.mode !== "replace") {
    throw new UsageError('--key requires --mode "replace"');
  }

  const scoped = shouldPromptForScope(opts, {
    stdinIsTTY: process.stdin.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
  })
    ? { ...opts, countries: await promptForCountries() }
    : opts;

  // No positional arguments: read stdin as a single input.
  if (scoped.files.length === 0) {
    const [input] = await readInputs(scoped.files);
    if (!input) throw new UsageError("no input to anonymize");
    guardWriteTargets([], collectSingleTargets(scoped));
    const runtime = await prepareCliRuntime(
      api,
      await buildPipelineConfig(scoped, loadDictionaries),
    );
    await runAnonymiseSingle(scoped, runtime, api, {
      text: input.text,
      outputPath: scoped.output,
      source: "stdin",
    });
    return;
  }

  const { jobs, batch, skipped } = await expandInputs(
    scoped.files,
    scoped.recursive,
    scoped.output,
  );

  if (!batch) {
    // Exactly one plain file: single-input flow with --json/--key.
    const [job] = jobs;
    if (!job) throw new UsageError("no input to anonymize");
    guardWriteTargets([job.path], collectSingleTargets(scoped));
    const runtime = await prepareCliRuntime(
      api,
      await buildPipelineConfig(scoped, loadDictionaries),
    );
    await runAnonymiseSingle(scoped, runtime, api, {
      text: await readFile(job.path, "utf8"),
      outputPath: scoped.output,
      source: job.path,
    });
    return;
  }

  // Batch: a directory, or more than one file.
  const output = scoped.output;
  if (output === undefined) {
    throw new UsageError(
      "batch input (a directory or multiple files) requires --output <directory>",
    );
  }
  if (scoped.keyPath !== undefined) {
    throw new UsageError("--key works with a single input only");
  }
  if (scoped.json) {
    throw new UsageError("--json works with a single input only");
  }

  // Validate every write target before any work: colliding
  // output paths (same basename from different input dirs,
  // symlinks to an input) fail fast instead of silently
  // clobbering files mid-batch.
  guardWriteTargets(
    jobs.map((job) => job.path),
    jobs.map((job) => ({
      path: join(output, job.outputRelative),
      flag: "--output",
    })),
  );

  const runtime = await prepareCliRuntime(
    api,
    await buildPipelineConfig(scoped, loadDictionaries),
  );
  await runAnonymiseBatch(scoped, runtime, output, jobs, skipped);
};

/** Write targets for a single-input run: --output and --key. */
const collectSingleTargets = (
  opts: CliOptions,
): { path: string; flag: string }[] => {
  const targets: { path: string; flag: string }[] = [];
  if (opts.output !== undefined) {
    targets.push({ path: opts.output, flag: "--output" });
  }
  if (opts.keyPath !== undefined) {
    targets.push({ path: opts.keyPath, flag: "--key" });
  }
  return targets;
};

type CliRuntime = {
  redact: (
    fullText: string,
    operators: NativeOperatorConfig,
  ) => Promise<{ entities: CliEntity[]; redaction: CliRedactionResult }>;
};

const prepareNativeCliPipeline = async (
  api: AnonymizeApi,
  config: PipelineConfig,
): Promise<NativeCliPipeline> => {
  const pipeline = await api.createNativePipelineFromConfig({
    binding: api.loadNativeAnonymizeBinding(),
    config,
    gazetteerEntries: [],
  });
  pipeline.warmLazyRegex?.();
  return pipeline;
};

const prepareCliRuntime = async (
  api: AnonymizeApi,
  config: PipelineConfig,
): Promise<CliRuntime> => {
  const pipeline = await prepareNativeCliPipeline(api, config);
  return {
    redact: async (fullText, operators) => {
      const result = pipeline.redactText(fullText, operators);
      return {
        entities: result.resolvedEntities,
        redaction: result.redaction,
      };
    },
  };
};

/**
 * Render the canonical entity labels and the short aliases
 * accepted by --labels, for the --list-labels discovery flag.
 */
const formatLabelList = (): string => {
  const lines: string[] = ["Detectable entity labels (pass to --labels):"];
  for (const label of ENTITY_LABELS) {
    lines.push(`  ${label}`);
  }
  lines.push("", "Short aliases:");
  const aliases = Object.entries(LABEL_ALIASES);
  let width = 0;
  for (const [alias] of aliases) {
    width = Math.max(width, alias.length);
  }
  for (const [alias, canonical] of aliases) {
    lines.push(`  ${alias.padEnd(width)}  ->  ${canonical}`);
  }
  return `${lines.join("\n")}\n`;
};

const dispatch = async (engine: CliEngine): Promise<void> => {
  const argv = process.argv.slice(2);
  if (argv.at(0) === "docx") {
    await runDocxCommand({
      argv: argv.slice(1),
      preparePipeline: async (
        request: DocxPipelineRequest,
      ): Promise<DocxCliPipeline> => {
        const options: PipelineConfigOptions =
          request.type === "anonymize"
            ? request.detection
            : {
                countries: [],
                languages: [],
                threshold: DEFAULT_THRESHOLD,
              };
        return prepareNativeCliPipeline(
          engine.api,
          await buildPipelineConfig(options, engine.loadDictionaries),
        );
      },
    });
    return;
  }
  if (argv.at(0) === "feedback") {
    await runFeedbackCommand({
      argv: argv.slice(1),
      readStdin,
      write: (text) => {
        process.stdout.write(text);
      },
    });
    return;
  }
  if (argv.at(0) === "pdf") {
    await runPdfCommand({
      argv: argv.slice(1),
      preparePipeline: async (
        request: PdfPipelineRequest,
      ): Promise<PdfCliPipeline> =>
        prepareNativeCliPipeline(
          engine.api,
          await buildPipelineConfig(request.detection, engine.loadDictionaries),
        ),
    });
    return;
  }
  const opts = parseCliArgs(argv);
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  if (opts.version) {
    process.stdout.write(`${cliVersion()}\n`);
    return;
  }
  if (opts.listLabels) {
    process.stdout.write(formatLabelList());
    return;
  }
  if (opts.capabilities) {
    process.stdout.write(`${JSON.stringify(CAPABILITY_MANIFEST, null, 2)}\n`);
    return;
  }
  if (opts.deanonymiseKeyPath !== undefined) {
    await runDeanonymise(opts, engine.api);
    return;
  }
  if (opts.revert !== undefined) {
    throw new UsageError("--revert requires --deanonymise <key>");
  }
  await runAnonymise(opts, engine);
};

/**
 * Run the CLI against the given engine and set the
 * process exit code (0 ok, 1 runtime error, 2 usage).
 */
export const runCli = async (engine: CliEngine): Promise<void> => {
  try {
    // Install the runtime binding (wasm under Bun) before any native call.
    // A no-op on Node, where the CLI ships to run.
    await preloadNativeBinding();
    await dispatch(engine);
  } catch (err) {
    const surface = isAnonymizeSurfaceError(err) ? err : mapFsError(err);
    if (err instanceof UsageError) {
      process.stderr.write(`anonymize: ${err.message}\n`);
      process.stderr.write(`Try "anonymize --help" for usage.\n`);
      process.exitCode = 2;
    } else if (surface !== undefined) {
      process.stderr.write(`anonymize: ${surface.message}\n`);
      process.stderr.write(`hint: ${surface.hint}\n`);
      process.exitCode = exitCodeForError(surface);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`anonymize: ${message}\n`);
      process.exitCode = 1;
    }
  }
};

/**
 * Map a raw filesystem error to the agent-surface taxonomy so a missing or
 * inaccessible input/output path exits with a stable code instead of the
 * generic runtime-error class. Returns undefined for anything else.
 */
const mapFsError = (error: unknown): AnonymizeSurfaceError | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return new AnonymizeSurfaceError("not_found", "input path does not exist", {
      hint: "Check the path; pass an existing file or directory.",
      cause: error,
    });
  }
  if (code === "EACCES" || code === "EPERM") {
    return new AnonymizeSurfaceError(
      "path_not_allowed",
      "permission denied for the given path",
      {
        hint: "Adjust file permissions or choose an accessible path.",
        cause: error,
      },
    );
  }
  return undefined;
};
