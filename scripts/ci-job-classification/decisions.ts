import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  CLASSIFICATION_DECISIONS_PATH,
  type ClassificationDecision,
  decisionPathForKey,
  LEGACY_CLASSIFICATION_DECISIONS_PATH,
} from "./inputs";
import { AdmissionError } from "./yaml";

// Reading and writing the per-job decision files. Kept out of inputs.ts,
// which the autofix planner loads without package dependencies.

export const decisionKeyFromPath = (file: string) => {
  const prefix = `${CLASSIFICATION_DECISIONS_PATH}/`;
  if (!file.startsWith(prefix) || !file.endsWith(".json")) {
    throw new AdmissionError({
      message: `Invalid classification decision path: ${file}`,
    });
  }
  const key = decodeURIComponent(file.slice(prefix.length, -".json".length));
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

const git = (root: string, args: string[]) => {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
};

export const readDecisions = (
  source: DecisionSource,
): Record<string, unknown> => {
  const collect = (entries: [string, unknown][]) => {
    const decisions: Record<string, unknown> = {};
    for (const [key, value] of entries) {
      if (decisions[key] !== undefined) {
        throw new AdmissionError({
          message: `Duplicate classification decision key: ${key}`,
        });
      }
      decisions[key] = value;
    }
    return decisions;
  };
  const parseJson = (text: string): unknown => JSON.parse(text);
  if (source.type === "working-tree") {
    const directory = path.resolve(source.root, CLASSIFICATION_DECISIONS_PATH);
    const entries = readdirSync(directory)
      .toSorted()
      .map((name) => {
        const file = `${CLASSIFICATION_DECISIONS_PATH}/${name}`;
        return [
          decisionKeyFromPath(file),
          parseJson(readFileSync(path.resolve(source.root, file), "utf-8")),
        ] satisfies [string, unknown];
      });
    return collect(entries);
  }

  const listed = git(source.root, [
    "ls-tree",
    "-r",
    "--name-only",
    source.revision,
    "--",
    CLASSIFICATION_DECISIONS_PATH,
  ]);
  const files = listed.stdout.split("\n").filter(Boolean).toSorted();
  if (files.length > 0) {
    const entries = files.map((file) => {
      const shown = git(source.root, ["show", `${source.revision}:${file}`]);
      if (shown.exitCode !== 0) {
        throw new AdmissionError({ message: shown.stderr.trim() });
      }
      return [decisionKeyFromPath(file), parseJson(shown.stdout)] satisfies [
        string,
        unknown,
      ];
    });
    return collect(entries);
  }

  const legacy = git(source.root, [
    "show",
    `${source.revision}:${LEGACY_CLASSIFICATION_DECISIONS_PATH}`,
  ]);
  if (legacy.exitCode !== 0) {
    throw new AdmissionError({ message: legacy.stderr.trim() });
  }
  const parsed = parseJson(legacy.stdout);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AdmissionError({ message: "Invalid legacy decision record" });
  }
  return Object.fromEntries(Object.entries(parsed));
};

export const writeDecision = (
  root: string,
  key: string,
  value: ClassificationDecision,
) => {
  const file = path.resolve(root, decisionPathForKey(key));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
