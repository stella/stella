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

const isE2eUnitTest = (filePath: string): boolean =>
  normalize(filePath).startsWith(`${E2E_UNIT_DIRECTORY}/`);

/**
 * With no paths, the three default runs, each carrying the pass-through flags.
 * With paths, only the named files, grouped by kind; a directory expands to
 * the test files under it. An argument is a path only when it exists on disk,
 * so flag values such as `-t "<name>"` stay flags.
 */
export const planTestRuns = ({
  argv,
  pathKind,
  testFilesIn,
}: TestRunPlanInput): readonly TestRun[] => {
  const flags: string[] = [];
  const files: string[] = [];
  for (const arg of argv) {
    if (arg === "--") {
      continue;
    }
    const kind = arg.startsWith("-") ? "missing" : pathKind(arg);
    if (kind === "file") {
      files.push(normalize(arg));
    } else if (kind === "directory") {
      files.push(...testFilesIn(arg).map(normalize));
    } else {
      flags.push(arg);
    }
  }

  const namedPaths = argv.some(
    (arg) => !arg.startsWith("-") && pathKind(arg) !== "missing",
  );
  if (!namedPaths) {
    return DEFAULT_RUNS.map((run) => ({
      label: run.label,
      args: [...run.args, ...flags],
    }));
  }

  const unique = [...new Set(files)];
  const dom = unique.filter(isDomTest);
  const e2eUnit = unique.filter(
    (file) => !isDomTest(file) && isE2eUnitTest(file),
  );
  const unit = unique.filter(
    (file) => !isDomTest(file) && !isE2eUnitTest(file),
  );
  const toPath = (file: string): string => `./${file}`;

  return [
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
};
