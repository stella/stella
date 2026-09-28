import { panic } from "better-result";
import path from "node:path";

/**
 * Splits `bun run test` arguments into the `bun test` invocations the web
 * package needs. The suite has three kinds of test file, each with its own
 * runner flags, so a bare `bun test <file>` either misses the flags or, when
 * the kinds are chained in one script, runs every other kind in full.
 */

export type TestRun = {
  readonly label: string;
  readonly args: readonly string[];
};

export type PathKind = "file" | "directory" | "missing";

export type TestRunPlan = {
  readonly runs: readonly TestRun[];
  /** Path-like arguments that name nothing on disk. */
  readonly missingPaths: readonly string[];
};

type TestRunPlanInput = {
  readonly argv: readonly string[];
  /** Whether a positional argument names a file or directory on disk. */
  readonly pathKind: (arg: string) => PathKind;
  /** Test files under a directory argument, relative to the package root. */
  readonly testFilesIn: (directory: string) => readonly string[];
};

const DOM_TEST_SUFFIX = ".dom.test.tsx";
const E2E_UNIT_DIRECTORY = "e2e/unit";
const E2E_DIRECTORY_PATTERN = "e2e/**";

const DEFAULT_RUNS: readonly TestRun[] = [
  {
    label: "unit",
    args: [
      `--path-ignore-patterns=${E2E_DIRECTORY_PATTERN}`,
      `--path-ignore-patterns=**/*${DOM_TEST_SUFFIX}`,
    ],
  },
  { label: "dom", args: ["--isolate", ".dom.test"] },
  { label: "e2e-unit", args: ["--parallel=2", E2E_UNIT_DIRECTORY] },
];

const normalize = (filePath: string): string =>
  filePath.replace(/^\.\//u, "").replaceAll("\\", "/");

const isDomTest = (filePath: string): boolean =>
  filePath.endsWith(DOM_TEST_SUFFIX);

/**
 * A missing argument that looks like a path is a mistyped path, not a name
 * filter: passing it on would let Bun match some other file by substring.
 */
const looksLikePath = (arg: string): boolean =>
  arg.includes("/") ||
  arg.includes("\\") ||
  arg.endsWith(".test.ts") ||
  arg.endsWith(".test.tsx");

const isE2eUnitTest = (filePath: string): boolean => {
  const normalized = normalize(filePath);
  return (
    normalized.startsWith(`${E2E_UNIT_DIRECTORY}/`) ||
    normalized.includes(`/${E2E_UNIT_DIRECTORY}/`)
  );
};

/**
 * `bun test` options whose value may follow as the next argument; that value
 * is never a test path, even when a file or directory of the same name exists.
 */
const VALUE_OPTIONS = new Set([
  "-t",
  "--test-name-pattern",
  "--timeout",
  "--rerun-each",
  "--retry",
  "-r",
  "--preload",
  "--seed",
  "--reporter",
  "--reporter-outfile",
  "--coverage-reporter",
  "--coverage-dir",
  "--path-ignore-patterns",
  "--max-concurrency",
]);

const REPORTER_OUTFILE = "--reporter-outfile";

/** `results.xml` for the `dom` run becomes `results.dom.xml`. */
const suiteOutfile = (outfile: string, label: string): string => {
  const extension = path.extname(outfile);
  return `${outfile.slice(0, outfile.length - extension.length)}.${label}${extension}`;
};

/**
 * Several runs given one `--reporter-outfile` would each overwrite the
 * previous run's report, so each run writes its own file instead.
 */
const withSuiteOutfiles = (runs: readonly TestRun[]): readonly TestRun[] =>
  runs.length < 2
    ? runs
    : runs.map((run) => ({
        label: run.label,
        args: run.args.map((arg, index) => {
          if (arg.startsWith(`${REPORTER_OUTFILE}=`)) {
            const outfile = arg.slice(REPORTER_OUTFILE.length + 1);
            return `${REPORTER_OUTFILE}=${suiteOutfile(outfile, run.label)}`;
          }
          return run.args[index - 1] === REPORTER_OUTFILE
            ? suiteOutfile(arg, run.label)
            : arg;
        }),
      }));

/**
 * With no paths, the three default runs, each carrying the pass-through flags.
 * With paths, only the named files, grouped by kind; a directory expands to
 * the test files under it. An argument is a path only when it exists on disk
 * and is not the value of an option such as `-t "<name>"`; a path-like
 * argument that names nothing is reported rather than run as a filter.
 * When more than one run is planned, a `--reporter-outfile` is split per run.
 */
export const planTestRuns = ({
  argv,
  pathKind,
  testFilesIn,
}: TestRunPlanInput): TestRunPlan => {
  const flags: string[] = [];
  const files: string[] = [];
  const missingPaths: string[] = [];
  let namedPaths = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? panic("Argument index out of range");
    if (arg === "--") {
      continue;
    }
    if (arg.startsWith("-")) {
      flags.push(arg);
      const value = argv[index + 1];
      if (VALUE_OPTIONS.has(arg) && value !== undefined) {
        flags.push(value);
        index += 1;
      }
      continue;
    }
    const kind = pathKind(arg);
    if (kind === "file") {
      namedPaths = true;
      files.push(normalize(arg));
    } else if (kind === "directory") {
      namedPaths = true;
      files.push(...testFilesIn(arg).map(normalize));
    } else if (looksLikePath(arg)) {
      missingPaths.push(arg);
    } else {
      flags.push(arg);
    }
  }

  if (missingPaths.length > 0) {
    return { runs: [], missingPaths };
  }

  if (!namedPaths) {
    return {
      runs: withSuiteOutfiles(
        DEFAULT_RUNS.map((run) => ({
          label: run.label,
          args: [...run.args, ...flags],
        })),
      ),
      missingPaths,
    };
  }

  const unique = [...new Set(files)];
  const dom = unique.filter(isDomTest);
  const e2eUnit = unique.filter(
    (file) => !isDomTest(file) && isE2eUnitTest(file),
  );
  const unit = unique.filter(
    (file) => !isDomTest(file) && !isE2eUnitTest(file),
  );
  // Bun reads a bare relative name as a filter, so relative paths are pinned
  // with `./`; absolute paths (POSIX, drive-rooted or UNC) already resolve.
  const toPath = (file: string): string =>
    path.win32.isAbsolute(file) ? file : `./${file}`;

  const runs = [
    {
      label: "unit",
      args: [...unit.map(toPath), ...flags],
      count: unit.length,
    },
    {
      label: "dom",
      args: ["--isolate", ...dom.map(toPath), ...flags],
      count: dom.length,
    },
    {
      label: "e2e-unit",
      args: ["--parallel=2", ...e2eUnit.map(toPath), ...flags],
      count: e2eUnit.length,
    },
  ]
    .filter((run) => run.count > 0)
    .map(({ label, args }) => ({ label, args }));
  return { runs: withSuiteOutfiles(runs), missingPaths };
};
