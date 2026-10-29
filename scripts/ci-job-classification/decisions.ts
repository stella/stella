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
  approvalPathForKey,
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
  const parseRecord = (text: string) => {
    const value = parseJson(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new AdmissionError({
        message: "Classification decision must be an object",
      });
    }
    return Object.fromEntries(Object.entries(value));
  };
  if (source.type === "working-tree") {
    const directory = path.resolve(source.root, CLASSIFICATION_DECISIONS_PATH);
    const entries = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .toSorted((left, right) => compareCodeUnit(left.name, right.name))
      .map((entry) => {
        const name = entry.name;
        const file = `${CLASSIFICATION_DECISIONS_PATH}/${name}/decision.json`;
        const decision = parseRecord(
          readFileSync(path.resolve(source.root, file), "utf-8"),
        );
        const approvalNames = readdirSync(path.resolve(directory, name)).filter(
          (approval) => /^[0-9a-f]{64}\.json$/u.test(approval),
        );
        const approvedDigests = approvalNames.map((approval) => {
          const record = parseRecord(
            readFileSync(path.resolve(directory, name, approval), "utf-8"),
          );
          if (
            record["kind"] !== decision["kind"] ||
            record["qualifier"] !== decision["qualifier"] ||
            record["reviewedDigest"] !== approval.slice(0, -5)
          ) {
            throw new AdmissionError({
              message: `Approval does not match decision: ${name}/${approval}`,
            });
          }
          return approval.slice(0, -5);
        });
        return [
          decisionKeyFromPath(file),
          {
            kind: decision["kind"],
            qualifier: decision["qualifier"],
            approvedDigests:
              typeof decision["reviewedDigest"] === "string"
                ? [...approvedDigests, decision["reviewedDigest"]]
                : approvedDigests,
          },
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
  const files = listed.stdout
    .split("\n")
    .filter((file) => file.endsWith("/decision.json"))
    .toSorted();
  if (files.length > 0) {
    const entries = files.map((file) => {
      const shown = git(source.root, ["show", `${source.revision}:${file}`]);
      if (shown.exitCode !== 0) {
        throw new AdmissionError({ message: shown.stderr.trim() });
      }
      const directory = file.slice(0, -"decision.json".length);
      const approvalFiles = listed.stdout
        .split("\n")
        .filter(
          (candidate) =>
            candidate.startsWith(directory) &&
            /\/[0-9a-f]{64}\.json$/u.test(candidate),
        );
      const decision = parseRecord(shown.stdout);
      const approvedDigests = approvalFiles.map((approvalFile) => {
        const approval = git(source.root, [
          "show",
          `${source.revision}:${approvalFile}`,
        ]);
        const record = parseRecord(approval.stdout);
        const digest = path.basename(approvalFile, ".json");
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
      return [
        decisionKeyFromPath(file),
        {
          kind: decision["kind"],
          qualifier: decision["qualifier"],
          approvedDigests:
            typeof decision["reviewedDigest"] === "string"
              ? [...approvedDigests, decision["reviewedDigest"]]
              : approvedDigests,
        },
      ] satisfies [string, unknown];
    });
    return collect(entries);
  }

  const flatFiles = listed.stdout
    .split("\n")
    .filter(
      (file) =>
        file.startsWith(`${CLASSIFICATION_DECISIONS_PATH}/`) &&
        file.endsWith(".json") &&
        !file.slice(`${CLASSIFICATION_DECISIONS_PATH}/`.length).includes("/"),
    );
  if (flatFiles.length > 0) {
    return collect(
      flatFiles.map((file) => {
        const shown = git(source.root, ["show", `${source.revision}:${file}`]);
        const value = parseRecord(shown.stdout);
        const key = decodeURIComponent(path.basename(file, ".json"));
        return [
          key,
          {
            kind: value["kind"],
            qualifier: value["qualifier"],
            approvedDigests:
              typeof value["reviewedDigest"] === "string"
                ? [value["reviewedDigest"]]
                : [],
          },
        ] satisfies [string, unknown];
      }),
    );
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
  const {
    approvedDigests: _approvedDigests,
    reviewedDigest,
    ...decision
  } = value;
  writeFileSync(file, `${JSON.stringify(decision, null, 2)}\n`);
  if (typeof reviewedDigest === "string") {
    writeApproval(root, key, reviewedDigest, {
      ...decision,
      approvedDigests: [],
    });
  }
};

export const writeApproval = (
  root: string,
  key: string,
  digest: string,
  decision: ClassificationDecision,
) => {
  const file = path.resolve(root, approvalPathForKey(key, digest));
  mkdirSync(path.dirname(file), { recursive: true });
  if (!existsSync(file)) {
    writeFileSync(
      file,
      `${JSON.stringify({ kind: decision.kind, qualifier: decision.qualifier, reviewedDigest: digest }, null, 2)}\n`,
      { flag: "wx" },
    );
  }
};
