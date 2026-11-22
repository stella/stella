// Every committed path the job classification reads. CI checks out exactly
// these at the workflow revision, the autofix planner selects the decision
// pruning by them, and the pre-push hook runs only when a push touches one.
// The autofix planner loads this from a sparse checkout without package
// dependencies.
export const CLASSIFICATION_DECISIONS_PATH =
  ".github/ci-job-classification-decisions";

export const CLASSIFICATION_DECISIONS_FILE = `${CLASSIFICATION_DECISIONS_PATH}/decisions.json`;

export type ClassificationDecision = {
  kind: unknown;
  qualifier: unknown;
};

export const decisionDirectoryForKey = (_key: string) =>
  CLASSIFICATION_DECISIONS_FILE;

export const decisionPathForKey = (_key: string) =>
  CLASSIFICATION_DECISIONS_FILE;

export const CLASSIFICATION_INPUT_PATHS = [
  ".github/workflows",
  ".github/actions",
  CLASSIFICATION_DECISIONS_PATH,
  ".github/ci-job-classification-sources.json",
  ".github/global-rule-inputs.json",
  "scripts/check-ci-job-classification.ts",
  "scripts/ci-job-classification",
  "packages/collation/src/collation.ts",
  "packages/sha256/src/node.ts",
] as const;

const DIRECTORY_INPUTS = new Set<string>([
  ".github/workflows",
  ".github/actions",
  "scripts/ci-job-classification",
  CLASSIFICATION_DECISIONS_PATH,
]);

// The same paths as globs, directories covering everything below them.
export const CLASSIFICATION_INPUT_GLOBS = CLASSIFICATION_INPUT_PATHS.map(
  (input) => (DIRECTORY_INPUTS.has(input) ? `${input}/**` : input),
);

export const isClassificationInput = (file: string) =>
  CLASSIFICATION_INPUT_PATHS.some((input) =>
    DIRECTORY_INPUTS.has(input) ? file.startsWith(`${input}/`) : file === input,
  );
