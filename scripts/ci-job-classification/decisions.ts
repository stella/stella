import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { compareCodeUnit } from "../../packages/collation/src/collation";
import {
  approvalPathForKey,
  CLASSIFICATION_DECISIONS_PATH,
  type ClassificationDecision,
  decisionDirectoryForKey,
  decisionPathForKey,
} from "./inputs";
import { readFilesAtRevision } from "./revision-files";
import { AdmissionError } from "./yaml";

// Reading and writing the per-job decision files. Kept out of inputs.ts,
// which the autofix planner loads without package dependencies.

export const decisionKeyFromPath = (file: string) => {
  const prefix = `${CLASSIFICATION_DECISIONS_PATH}/`;
  if (!file.startsWith(prefix) || !file.endsWith("/decision.json")) {
    throw new AdmissionError({
      message: `Invalid classification decision path: ${file}`,
    });
  }
  const key = decodeURIComponent(
    file.slice(prefix.length, -"/decision.json".length),
  );
  if (decisionPathForKey(key) !== file) {
    throw new AdmissionError({
      message: `Non-canonical classification decision path: ${file}`,
    });
  }
  return key;
};

type DecisionSource =
  | { type: "working-tree"; root: string }
  | { type: "git-revision"; root: string; revision: string };

type ReadDecisionsOptions = {
  observeRead?: ((file: string) => void) | undefined;
};

const DECISION_FILE = "decision.json";
const APPROVAL_FILE = /^[0-9a-f]{64}\.json$/u;

const git = (root: string, args: string[]) => {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new AdmissionError({
      message:
        new TextDecoder().decode(result.stderr).trim() ||
        `git ${args.join(" ")} failed`,
    });
  }
  return new TextDecoder().decode(result.stdout);
};

type DecisionFiles = { files: string[]; read: (file: string) => string };

const workingTreeFiles = (root: string): DecisionFiles => {
  const directory = path.resolve(root, CLASSIFICATION_DECISIONS_PATH);
  // Git tracks no empty directory, so a tree without a privileged job has
  // none; that is "no decisions", not a failed read.
  const entries = existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true })
    : [];
  return {
    files: entries.flatMap((entry) =>
      entry.isDirectory()
        ? readdirSync(path.resolve(directory, entry.name)).map(
            (name) => `${CLASSIFICATION_DECISIONS_PATH}/${entry.name}/${name}`,
          )
        : [`${CLASSIFICATION_DECISIONS_PATH}/${entry.name}`],
    ),
    read: (file) => readFileSync(path.resolve(root, file), "utf-8"),
  };
};

const revisionFiles = (root: string, revision: string): DecisionFiles => {
  const files = git(root, [
    "ls-tree",
    "-r",
    "--name-only",
    revision,
    "--",
    CLASSIFICATION_DECISIONS_PATH,
  ])
    .split("\n")
    .filter((file) => file.length > 0);
  // Every decision file at the revision in one read, not one git per file.
  const contents = readFilesAtRevision(root, revision, files);
  return {
    files,
    read: (file) =>
      contents.get(file) ?? git(root, ["show", `${revision}:${file}`]),
  };
};

const parseRecord = (text: string) => {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AdmissionError({
      message: "Classification decision must be an object",
    });
  }
  return Object.fromEntries(Object.entries(value));
};

// The file names of each job directory. Anything else under the decisions
// path fails: a file this reader skipped would stay in the tree unreviewed.
const jobDirectories = (files: readonly string[]) => {
  const prefix = `${CLASSIFICATION_DECISIONS_PATH}/`;
  const directories = new Map<string, string[]>();
  for (const file of files.toSorted(compareCodeUnit)) {
    // Desktop tools drop untracked dotfiles into directories they browse.
    if (path.basename(file).startsWith(".")) {
      continue;
    }
    const [directory, name, ...nested] = file.slice(prefix.length).split("/");
    if (
      directory === undefined ||
      name === undefined ||
      nested.length > 0 ||
      (name !== DECISION_FILE && !APPROVAL_FILE.test(name))
    ) {
      throw new AdmissionError({
        message: `Unexpected classification decision file: ${file}. Each job has one directory holding decision.json and its <digest>.json approvals`,
      });
    }
    directories.set(directory, [...(directories.get(directory) ?? []), name]);
  }
  return directories;
};

export const readDecisions = (
  source: DecisionSource,
  { observeRead }: ReadDecisionsOptions = {},
): Record<string, unknown> => {
  const { files, read } =
    source.type === "working-tree"
      ? workingTreeFiles(source.root)
      : revisionFiles(source.root, source.revision);
  const decisions: Record<string, unknown> = {};
  for (const [directory, names] of jobDirectories(files)) {
    const directoryPath = `${CLASSIFICATION_DECISIONS_PATH}/${directory}`;
    if (!names.includes(DECISION_FILE)) {
      throw new AdmissionError({
        message: `Approvals without a decision: ${directoryPath}. Add decision.json or remove the directory`,
      });
    }
    const decisionFile = `${directoryPath}/${DECISION_FILE}`;
    const key = decisionKeyFromPath(decisionFile);
    observeRead?.(decisionFile);
    const decision = parseRecord(read(decisionFile));
    const approvedDigests = names
      .filter((name) => name !== DECISION_FILE)
      .map((name) => {
        const approvalFile = `${directoryPath}/${name}`;
        observeRead?.(approvalFile);
        const record = parseRecord(read(approvalFile));
        const digest = name.slice(0, -".json".length);
        if (
          record["kind"] !== decision["kind"] ||
          record["qualifier"] !== decision["qualifier"] ||
          record["reviewedDigest"] !== digest
        ) {
          throw new AdmissionError({
            message: `Approval does not match decision: ${approvalFile}`,
          });
        }
        return digest;
      });
    decisions[key] = {
      kind: decision["kind"],
      qualifier: decision["qualifier"],
      approvedDigests,
    };
  }
  return decisions;
};

export const writeDecision = (
  root: string,
  key: string,
  value: ClassificationDecision,
) => {
  const file = path.resolve(root, decisionPathForKey(key));
  mkdirSync(path.dirname(file), { recursive: true });
  const {
    approvedDigests: _approvedDigests,
    reviewedDigest,
    ...decision
  } = value;
  writeFileSync(file, `${JSON.stringify(decision, null, 2)}\n`);
  if (typeof reviewedDigest !== "string") {
    return;
  }
  // An approval is add-only: two branches that approve the same job add two
  // files and merge without a conflict.
  const approval = path.resolve(root, approvalPathForKey(key, reviewedDigest));
  if (!existsSync(approval)) {
    writeFileSync(
      approval,
      `${JSON.stringify({ kind: decision.kind, qualifier: decision.qualifier, reviewedDigest }, null, 2)}\n`,
      { flag: "wx" },
    );
  }
};

export const removeDecision = (root: string, key: string) => {
  rmSync(path.resolve(root, decisionDirectoryForKey(key)), {
    recursive: true,
  });
};
