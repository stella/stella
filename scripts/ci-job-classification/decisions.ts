import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { CLASSIFICATIONS } from "./classification-values";
import { AdmissionError } from "./yaml";

export const CLASSIFICATION_DECISIONS_PATH =
  ".github/ci-job-classification-decisions";

export const DECISION = v.strictObject({
  kind: v.picklist(CLASSIFICATIONS),
  qualifier: v.pipe(v.string(), v.minLength(1)),
  reviewedDigest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)),
});
export const DECISIONS = v.record(v.string(), DECISION);
export type Decisions = v.InferOutput<typeof DECISIONS>;

const encodePart = (value: string) => {
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) =>
      `%${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()}`,
  );
  if (encoded === ".") {
    return "%2E";
  }
  if (encoded === "..") {
    return "%2E%2E";
  }
  return encoded;
};

export const decisionPath = (key: string) => {
  const colon = key.indexOf(":");
  const slash = key.lastIndexOf("/");
  if (colon < 1 || slash <= colon + 1 || slash === key.length - 1) {
    throw new AdmissionError({ message: `Invalid decision key: ${key}` });
  }
  const repository = key.slice(0, colon);
  const metadataPath = key.slice(colon + 1, slash);
  const job = key.slice(slash + 1);
  const parts = metadataPath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new AdmissionError({ message: `Invalid decision key: ${key}` });
  }
  return `${CLASSIFICATION_DECISIONS_PATH}/${encodePart(repository)}/${parts
    .map(encodePart)
    .join("/")}/${encodePart(job)}.json`;
};

export const decisionKey = (file: string) => {
  const prefix = `${CLASSIFICATION_DECISIONS_PATH}/`;
  if (!file.startsWith(prefix) || !file.endsWith(".json")) {
    throw new AdmissionError({
      message: `Invalid decision file path: ${file}`,
    });
  }
  const parts = file.slice(prefix.length, -".json".length).split("/");
  if (parts.length < 3) {
    throw new AdmissionError({
      message: `Invalid decision file path: ${file}`,
    });
  }
  let decoded: string[];
  try {
    decoded = parts.map(decodeURIComponent);
  } catch {
    throw new AdmissionError({
      message: `Invalid decision file path: ${file}`,
    });
  }
  const repository = decoded.at(0);
  const job = decoded.at(-1);
  const metadata = decoded.slice(1, -1);
  if (!repository || !job || metadata.length === 0) {
    throw new AdmissionError({
      message: `Invalid decision file path: ${file}`,
    });
  }
  const key = `${repository}:${metadata.join("/")}/${job}`;
  if (decisionPath(key) !== file) {
    throw new AdmissionError({
      message: `Invalid decision file path: ${file}`,
    });
  }
  return key;
};

const parseDecision = (file: string, text: string) => {
  try {
    return v.parse(DECISION, JSON.parse(text));
  } catch (error) {
    throw new AdmissionError({
      message: `Invalid decision file ${file}: ${error instanceof Error ? error.message : "invalid JSON"}`,
    });
  }
};

export const readDecisions = (root: string): Decisions => {
  const directory = path.resolve(root, CLASSIFICATION_DECISIONS_PATH);
  const files = [
    ...new Bun.Glob("**/*").scanSync({
      cwd: directory,
      dot: true,
      onlyFiles: true,
    }),
  ]
    .map((file) => `${CLASSIFICATION_DECISIONS_PATH}/${file}`)
    .toSorted();
  return Object.fromEntries(
    files.map((file) => [
      decisionKey(file),
      parseDecision(file, readFileSync(path.resolve(root, file), "utf-8")),
    ]),
  );
};

export const readDecisionsAtRevision = (
  revision: string,
  gitText: (args: string[]) => string,
): Decisions => {
  const files = gitText([
    "ls-tree",
    "-r",
    "--name-only",
    revision,
    "--",
    CLASSIFICATION_DECISIONS_PATH,
  ])
    .split("\n")
    .filter(Boolean)
    .toSorted();
  if (files.length === 0) {
    // The merge base of the directory migration still has the former manifest.
    return v.parse(
      DECISIONS,
      JSON.parse(
        gitText([
          "show",
          `${revision}:.github/ci-job-classification-decisions.json`,
        ]),
      ),
    );
  }
  return Object.fromEntries(
    files.map((file) => [
      decisionKey(file),
      parseDecision(file, gitText(["show", `${revision}:${file}`])),
    ]),
  );
};
