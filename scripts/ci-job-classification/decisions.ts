import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { compareCodeUnit } from "../../packages/collation/src/collation";
import {
  CLASSIFICATION_DECISIONS_FILE,
  CLASSIFICATION_DECISIONS_PATH,
  type ClassificationDecision,
} from "./inputs";
import { readFilesAtRevision } from "./revision-files";
import { AdmissionError } from "./yaml";

// Reading and writing the committed job classification decisions file. Kept
// out of inputs.ts, which the autofix planner loads without package
// dependencies.

type DecisionSource =
  | { type: "working-tree"; root: string }
  | { type: "git-revision"; root: string; revision: string };

type ReadDecisionsOptions = {
  observeRead?: ((file: string) => void) | undefined;
};

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

const parseRecord = (text: string) => {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AdmissionError({
      message: "Classification decisions must be a JSON object",
    });
  }
  return Object.fromEntries(Object.entries(value));
};

const readLegacyRevisionDecisions = (
  root: string,
  revision: string,
  files: readonly string[],
  observeRead?: (file: string) => void,
): Record<string, unknown> => {
  const decisionFiles = files
    .filter((file) => file.endsWith("/decision.json"))
    .toSorted(compareCodeUnit);
  const contents = readFilesAtRevision(root, revision, decisionFiles);
  const prefix = `${CLASSIFICATION_DECISIONS_PATH}/`;
  const decisions: Record<string, unknown> = {};
  for (const file of decisionFiles) {
    observeRead?.(file);
    const key = decodeURIComponent(
      file.slice(prefix.length, -"/decision.json".length),
    );
    const record = parseRecord(
      contents.get(file) ?? git(root, ["show", `${revision}:${file}`]),
    );
    decisions[key] = {
      kind: record["kind"],
      qualifier: record["qualifier"],
    };
  }
  return decisions;
};

export const readDecisions = (
  source: DecisionSource,
  { observeRead }: ReadDecisionsOptions = {},
): Record<string, unknown> => {
  if (source.type === "git-revision") {
    const files = git(source.root, [
      "ls-tree",
      "-r",
      "--name-only",
      source.revision,
      "--",
      CLASSIFICATION_DECISIONS_PATH,
    ])
      .split("\n")
      .filter((file) => file.length > 0);
    if (files.length === 0) {
      return {};
    }
    if (!files.includes(CLASSIFICATION_DECISIONS_FILE)) {
      return readLegacyRevisionDecisions(
        source.root,
        source.revision,
        files,
        observeRead,
      );
    }
    observeRead?.(CLASSIFICATION_DECISIONS_FILE);
    return parseRecord(
      git(source.root, [
        "show",
        `${source.revision}:${CLASSIFICATION_DECISIONS_FILE}`,
      ]),
    );
  }

  const directory = path.resolve(source.root, CLASSIFICATION_DECISIONS_PATH);
  if (!existsSync(directory)) {
    return {};
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    if (entry.isDirectory() || entry.name !== "decisions.json") {
      throw new AdmissionError({
        message: `Unexpected classification decision entry: ${CLASSIFICATION_DECISIONS_PATH}/${entry.name}. Store all job classifications in ${CLASSIFICATION_DECISIONS_FILE}`,
      });
    }
  }
  const file = path.resolve(source.root, CLASSIFICATION_DECISIONS_FILE);
  if (!existsSync(file)) {
    return {};
  }
  observeRead?.(CLASSIFICATION_DECISIONS_FILE);
  return parseRecord(readFileSync(file, "utf-8"));
};

export const writeDecisionsMap = (
  root: string,
  decisions: Record<string, unknown>,
) => {
  const file = path.resolve(root, CLASSIFICATION_DECISIONS_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  const sorted = Object.fromEntries(
    Object.keys(decisions)
      .toSorted(compareCodeUnit)
      .map((key) => [key, decisions[key]]),
  );
  writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`);
};

export const writeDecision = (
  root: string,
  key: string,
  value: ClassificationDecision,
) => {
  const current = readDecisions({ type: "working-tree", root });
  current[key] = { kind: value.kind, qualifier: value.qualifier };
  writeDecisionsMap(root, current);
};

export const removeDecision = (root: string, key: string) => {
  const current = new Map(
    Object.entries(readDecisions({ type: "working-tree", root })),
  );
  if (!current.delete(key)) {
    return;
  }
  writeDecisionsMap(root, Object.fromEntries(current));
};
