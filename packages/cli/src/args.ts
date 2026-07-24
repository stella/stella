import { availableParallelism } from "node:os";
import { parseArgs } from "node:util";

export const CLI_MODES = ["replace", "redact"] as const;
export type CliMode = (typeof CLI_MODES)[number];

export const DEFAULT_THRESHOLD = 0.3;
export const DEFAULT_REDACT_STRING = "[REDACTED]";

/** Upper bound on the default worker count; batch I/O overlap
 * saturates well before this, and redaction itself is a
 * synchronous native call serialized on the JS thread. */
export const MAX_DEFAULT_WORKERS = 4;

/** Default batch concurrency: min(4, cores). Workers overlap
 * file reads/writes; the shared native pipeline runs each
 * redaction to completion on the single JS thread. */
export const defaultWorkerCount = (): number =>
  Math.max(1, Math.min(MAX_DEFAULT_WORKERS, availableParallelism()));

/** Invalid invocation; printed with usage hint, exit code 2. */
export class UsageError extends Error {}

export type CliOptions = {
  files: string[];
  output?: string | undefined;
  mode: CliMode;
  keyPath?: string | undefined;
  deanonymiseKeyPath?: string | undefined;
  revert?: string[] | undefined;
  recursive: boolean;
  workers: number;
  labels?: string[] | undefined;
  languages?: string[] | undefined;
  countries?: string[] | undefined;
  threshold: number;
  redactString: string;
  json: boolean;
  quiet: boolean;
  help: boolean;
  version: boolean;
  listLabels: boolean;
  capabilities: boolean;
};

export const HELP = `Usage: anonymize [options] [file|dir ...]

Detect and anonymize PII in text. Reads the given files, or stdin
when no files are given. A directory argument processes the text
files inside it (add --recursive to descend into subdirectories).
Writes to stdout, or to --output.
All processing is local; the CLI makes no network calls.

DOCX workflows:
  Run "anonymize docx --help" for structure-preserving DOCX anonymization
  and restoration with encrypted session archives.

PDF workflows:
  Run "anonymize pdf --help" for destructive local Poppler/Tesseract PDF
  anonymization into a verified fresh image-only output.

Feedback:
  Run "anonymize feedback --help" to report a bug or gap. It sanitizes your
  text locally and prints a prefilled GitHub issue URL you submit yourself;
  it makes no network calls.

Options:
  -o, --output <path>       Output file, or directory for batch
                            input (multiple files or a directory)
  -m, --mode <mode>         "replace" (reversible [PERSON_1]
                            placeholders) or "redact"
                            (default: replace)
  -k, --key <path>          Write the redaction key as JSON
                            (single input, replace mode)
  -d, --deanonymise <path>  Restore redacted text using the
                            redaction key at <path>
      --revert <term>       With --deanonymise, restore only the
                            given entity. Match a placeholder token
                            ("[PERSON_1]") or an original value
                            ("Jan Novák"), case-sensitive exact.
                            Repeatable; others stay redacted
  -r, --recursive           Descend into subdirectories when a
                            directory is given as input
      --workers <n>         Batch files to process concurrently
                            (default: min(${MAX_DEFAULT_WORKERS}, CPU cores)). Overlaps
                            file I/O; redaction is serialized on
                            the JS thread
      --labels <list>       Comma-separated entity labels to detect
                            (default: all). Accepts canonical labels
                            ("email address"), short aliases (email,
                            phone, org, dob, ssn), and hyphen/underscore
                            forms ("credit-card-number")
      --languages <list>    Name-corpus languages, e.g. "cs,de,en"
                            (default: all bundled)
      --countries <list>    ISO 3166-1 alpha-2 codes scoping deny
                            lists and city data, e.g. "CZ,DE,GB"
                            (default: all deny lists; city data
                            for a 30-country default set)
      --threshold <n>       Minimum confidence score, 0-1
                            (default: ${DEFAULT_THRESHOLD})
      --redact-string <s>   Replacement text in redact mode
                            (default: "${DEFAULT_REDACT_STRING}")
      --json                Emit JSON (entities + redacted text) to
                            stdout (single input only)
      --quiet               Suppress the summary on stderr
  -h, --help                Show this help
  -v, --version             Show the version
      --list-labels         List detectable entity labels and the
                            short aliases accepted by --labels
      --capabilities        Emit the versioned capability manifest as JSON

Batch input (directory or multiple files):
  Requires --output <directory>. The input tree is mirrored
  into the output directory. Directory walks process regular
  files only and skip likely-binary files (a NUL byte in the
  first 8 KiB); explicitly named files are always processed.
  The stderr summary reports how many files were processed,
  failed, and skipped; any failure sets exit code 1.
  --key and --json apply to single inputs only.

Interactive prompt:
  When run on files from a terminal without --countries or
  --languages, the CLI asks once which country scope to load.
  Piped stdin/stderr or --quiet skips the prompt, so scripts
  and agents never block on input.

Exit codes:
  0  success                  4  not found (missing path)
  1  runtime error            5  unsupported format
  2  usage error              6  output already exists
  3  path not allowed         7  session unavailable
                              8  dependency missing
  Messages and, for coded failures, a "hint:" line print on stderr.

JSON output (--json):
  { "entityCount": number,
    "entities": [{ "start": number, "end": number,
                   "label": string, "text": string,
                   "score": number, "source": string }],
    "redactedText": string }
  Offsets are UTF-16 code-unit indexes into the input.
  The stderr summary contains entity counts only, never
  the detected text.

Examples:
  anonymize contract.txt > contract.anon.txt
  anonymize -k contract.key.json -o contract.anon.txt contract.txt
  anonymize -d contract.key.json contract.anon.txt
  anonymize -r --workers 8 -o out/ docs/
  anonymize -d key.json --revert "[PERSON_1]" contract.anon.txt
  cat notes.md | anonymize --countries CZ,SK --languages cs,sk
  anonymize --json --quiet input.txt | jq '.entities[].label'
  anonymize docx --help
`;

const splitList = (value: string): string[] => [
  ...new Set(
    value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  ),
];

const parseThreshold = (raw: string): number => {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new UsageError(
      `--threshold must be a number between 0 and 1, got "${raw}"`,
    );
  }
  return value;
};

const parseWorkers = (raw: string): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(`--workers must be a positive integer, got "${raw}"`);
  }
  return value;
};

const parseMode = (raw: string): CliMode => {
  const mode = CLI_MODES.find((candidate) => candidate === raw);
  if (!mode) {
    throw new UsageError(
      `--mode must be one of: ${CLI_MODES.join(", ")}; got "${raw}"`,
    );
  }
  return mode;
};

const COUNTRY_CODE_RE = /^[A-Za-z]{2}$/;

export const parseCountries = (raw: string): string[] => {
  const countries = [
    ...new Set(splitList(raw).map((code) => code.toUpperCase())),
  ];
  const invalid = countries.find((code) => !COUNTRY_CODE_RE.test(code));
  if (invalid) {
    throw new UsageError(
      `--countries expects ISO 3166-1 alpha-2 codes (e.g. "CZ,DE"), got "${invalid}"`,
    );
  }
  return countries;
};

export const parseCliArgs = (argv: string[]): CliOptions => {
  let parsed: ReturnType<typeof parseArgs<typeof PARSE_CONFIG>>;
  try {
    parsed = parseArgs({ ...PARSE_CONFIG, args: argv });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const { values, positionals } = parsed;

  return {
    files: positionals,
    output: values.output,
    mode: values.mode === undefined ? "replace" : parseMode(values.mode),
    keyPath: values.key,
    deanonymiseKeyPath: values.deanonymise,
    revert:
      values.revert === undefined || values.revert.length === 0
        ? undefined
        : values.revert,
    recursive: values.recursive === true,
    workers:
      values.workers === undefined
        ? defaultWorkerCount()
        : parseWorkers(values.workers),
    labels: values.labels === undefined ? undefined : splitList(values.labels),
    languages:
      values.languages === undefined ? undefined : splitList(values.languages),
    countries:
      values.countries === undefined
        ? undefined
        : parseCountries(values.countries),
    threshold:
      values.threshold === undefined
        ? DEFAULT_THRESHOLD
        : parseThreshold(values.threshold),
    redactString: values["redact-string"] ?? DEFAULT_REDACT_STRING,
    json: values.json === true,
    quiet: values.quiet === true,
    help: values.help === true,
    version: values.version === true,
    listLabels: values["list-labels"] === true,
    capabilities: values.capabilities === true,
  };
};

const PARSE_CONFIG = {
  allowPositionals: true,
  strict: true,
  options: {
    output: { type: "string", short: "o" },
    mode: { type: "string", short: "m" },
    key: { type: "string", short: "k" },
    deanonymise: { type: "string", short: "d" },
    revert: { type: "string", multiple: true },
    recursive: { type: "boolean", short: "r" },
    workers: { type: "string" },
    labels: { type: "string" },
    languages: { type: "string" },
    countries: { type: "string" },
    threshold: { type: "string" },
    "redact-string": { type: "string" },
    json: { type: "boolean" },
    quiet: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    "list-labels": { type: "boolean" },
    capabilities: { type: "boolean" },
  },
} as const;
