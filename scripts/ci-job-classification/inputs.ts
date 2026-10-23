// Every committed path the job classification reads. CI checks out exactly
// these at the workflow revision, the autofix planner selects the digest
// refresh by them, and the pre-push hook runs only when a push touches one.
// No imports: the autofix planner loads this from a sparse checkout without
// dependencies.
export const CLASSIFICATION_DECISIONS_PATH =
  ".github/ci-job-classification-decisions";

export const CLASSIFICATION_INPUT_PATHS = [
  ".github/workflows",
  ".github/actions",
  CLASSIFICATION_DECISIONS_PATH,
  ".github/ci-job-classification-sources.json",
  "scripts/check-ci-job-classification.ts",
  "scripts/ci-job-classification",
  "packages/collation/src/collation.ts",
  "packages/sha256/src/node.ts",
  "packages/sha256/src/types.ts",
] as const;

const DIRECTORY_INPUTS = new Set<string>([
  ".github/workflows",
  ".github/actions",
  CLASSIFICATION_DECISIONS_PATH,
  "scripts/ci-job-classification",
]);

// The same paths as globs, directories covering everything below them.
export const CLASSIFICATION_INPUT_GLOBS = CLASSIFICATION_INPUT_PATHS.map(
  (input) => (DIRECTORY_INPUTS.has(input) ? `${input}/**` : input),
);

export const isClassificationInput = (file: string) =>
  CLASSIFICATION_INPUT_PATHS.some((input) =>
    DIRECTORY_INPUTS.has(input) ? file.startsWith(`${input}/`) : file === input,
  );
