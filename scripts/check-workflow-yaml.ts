#!/usr/bin/env bun

import { panic, TaggedError } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { flattenWorkflowSteps } from "./workflow-steps";

const WORKFLOW_DIRECTORY = ".github/workflows";
const ACTION_DIRECTORY = ".github/actions";
// GitHub rejects a workflow file over 512,000 bytes and then runs none of
// its jobs. Fail at 80 % of that, while there is still room to shrink it.
export const GITHUB_WORKFLOW_LIMIT_BYTES = 512_000;
export const WORKFLOW_SIZE_LIMIT_BYTES = GITHUB_WORKFLOW_LIMIT_BYTES * 0.8;

class WorkflowYamlError extends TaggedError("WorkflowYamlError")<{
  message: string;
  file: string;
  cause?: unknown;
}> {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireNonemptyString = (
  record: Record<string, unknown>,
  field: string,
  file: string,
): void => {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new WorkflowYamlError({
      message: `${file}: action ${field} must be a nonempty string`,
      file,
    });
  }
};

export const parseWorkflowYaml = async (file: string): Promise<unknown> => {
  const source = await Bun.file(file).text();
  try {
    return Bun.YAML.parse(source);
  } catch (error) {
    throw new WorkflowYamlError({
      message: `${file}: invalid YAML`,
      file,
      cause: error,
    });
  }
};

export const validateWorkflowSize = (bytes: number, file: string): void => {
  if (bytes > WORKFLOW_SIZE_LIMIT_BYTES) {
    throw new WorkflowYamlError({
      message: `${file}: ${bytes} bytes exceeds the ${WORKFLOW_SIZE_LIMIT_BYTES}-byte workflow size limit (80 % of GitHub's ${GITHUB_WORKFLOW_LIMIT_BYTES}-byte limit); move long step bodies into scripts checked out at github.workflow_sha, or share repeated steps through YAML anchors or a local action`,
      file,
    });
  }
};

export const validateActionMetadata = (value: unknown, file: string): void => {
  if (!isRecord(value)) {
    throw new WorkflowYamlError({
      message: `${file}: action metadata must be a mapping`,
      file,
    });
  }
  requireNonemptyString(value, "name", file);
  requireNonemptyString(value, "description", file);

  const runs = value["runs"];
  if (
    !isRecord(runs) ||
    typeof runs["using"] !== "string" ||
    runs["using"].trim() === ""
  ) {
    throw new WorkflowYamlError({
      message: `${file}: runs.using must be a nonempty string`,
      file,
    });
  }
  if (runs["using"] !== "composite") {
    return;
  }
  if (!Array.isArray(runs["steps"])) {
    throw new WorkflowYamlError({
      message: `${file}: runs.steps must be a sequence`,
      file,
    });
  }

  for (const [index, step] of runs["steps"].entries()) {
    if (!isRecord(step)) {
      throw new WorkflowYamlError({
        message: `${file}: runs.steps[${index}] must be a mapping`,
        file,
      });
    }
    if (
      "run" in step &&
      (typeof step["run"] !== "string" ||
        step["run"].trim() === "" ||
        typeof step["shell"] !== "string" ||
        step["shell"].trim() === "")
    ) {
      throw new WorkflowYamlError({
        message: `${file}: runs.steps[${index}] run and shell must be nonempty strings`,
        file,
      });
    }
  }
};

const YAML_EXTENSIONS = [".yml", ".yaml"] as const;

export const validateNoRubyShell = (value: unknown, file: string): void => {
  if (Array.isArray(value)) {
    for (const child of value) {
      validateNoRubyShell(child, file);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const shell = value["shell"];
  // Any command word naming ruby, so a path or an env launcher cannot hide it.
  if (
    typeof shell === "string" &&
    shell
      .split(/\s+/u)
      .some((word) => /^ruby[\d.]*$/u.test(word.split("/").at(-1) ?? ""))
  ) {
    throw new WorkflowYamlError({
      message: `${file}: Ruby workflow shells are not allowed`,
      file,
    });
  }
  for (const child of Object.values(value)) {
    validateNoRubyShell(child, file);
  }
};

export const validateWorkflowJobTimeouts = (
  value: unknown,
  file: string,
): void => {
  if (!isRecord(value) || !isRecord(value["jobs"])) {
    return;
  }
  for (const [jobName, job] of Object.entries(value["jobs"])) {
    if (isRecord(job) && "steps" in job && !("timeout-minutes" in job)) {
      throw new WorkflowYamlError({
        message: `${file}: job ${jobName} runs steps and must define timeout-minutes; every step-running workflow job requires a timeout`,
        file,
      });
    }
  }
};

export const validateNoRubyProcessSpawns = async (
  root: string,
): Promise<void> => {
  const scriptsDirectory = path.join(root, "scripts");
  if (!existsSync(scriptsDirectory)) {
    return;
  }
  const spawnPattern = new RegExp(
    `${String.raw`(?:Bun\.(?:spawn|spawnSync)|\b(?:spawn|spawnSync|execFile|execFileSync)\s*\()\s*(?:\{[^}]*cmd\s*:\s*)?\[?\s*["']`}ruby${String.raw`["']`}`,
    "su",
  );
  for await (const relative of new Bun.Glob(
    "**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
  ).scan({
    cwd: scriptsDirectory,
  })) {
    const file = path.join(root, "scripts", relative);
    if (spawnPattern.test(await Bun.file(file).text())) {
      throw new WorkflowYamlError({
        message: `${file}: spawning Ruby from scripts is not allowed`,
        file,
      });
    }
  }
};

const localActionReferences = (value: unknown): string[] => {
  if (!isRecord(value)) {
    return [];
  }
  const groups: unknown[] = [];
  if (isRecord(value["jobs"])) {
    for (const job of Object.values(value["jobs"])) {
      if (isRecord(job) && "steps" in job) {
        groups.push(job["steps"]);
      }
    }
  }
  if (isRecord(value["runs"]) && "steps" in value["runs"]) {
    groups.push(value["runs"]["steps"]);
  }
  return groups
    .flatMap((steps) => flattenWorkflowSteps(steps))
    .flatMap((step) => {
      const uses = step["uses"];
      return typeof uses === "string" &&
        (uses.startsWith("$/") || uses.startsWith("./"))
        ? [uses]
        : [];
    });
};

type LocalActionReferencesOptions = {
  value: unknown;
  root: string;
  file: string;
};

export const validateLocalActionReferences = ({
  value,
  root,
  file,
}: LocalActionReferencesOptions): void => {
  for (const uses of localActionReferences(value)) {
    // Archive targets belong to this repository; workspace actions can be checked out at runtime.
    if (!uses.startsWith("$/")) {
      continue;
    }
    const relative = uses.slice(2);
    if (
      relative === "" ||
      relative
        .split("/")
        .some((part) => part === "" || part === "." || part === "..") ||
      relative.includes("\\")
    ) {
      throw new WorkflowYamlError({
        message: `${file}: invalid local action ${uses}`,
        file,
      });
    }
    const directory = path.join(root, relative);
    const metadata = YAML_EXTENSIONS.map((extension) =>
      path.join(directory, `action${extension}`),
    ).filter(existsSync);
    const target = metadata.at(0);
    if (metadata.length !== 1 || target === undefined) {
      throw new WorkflowYamlError({
        message: `${file}: local action ${uses} must have exactly one metadata file`,
        file,
      });
    }
    validateActionMetadata(
      Bun.YAML.parse(readFileSync(target, "utf-8")),
      target,
    );
  }
};

/** Lint the archive spelling as an equivalent local path without editing workflows. */
type ActionlintWorkflowSourceOptions = {
  source: string;
  root: string;
  file: string;
};

export const actionlintWorkflowSource = ({
  source,
  root,
  file,
}: ActionlintWorkflowSourceOptions): string => {
  const value: unknown = Bun.YAML.parse(source);
  validateLocalActionReferences({ value, root, file });
  const expected = localActionReferences(value).filter((uses) =>
    uses.startsWith("$/"),
  );
  const rewritten: string[] = [];
  const normalized = source
    .split("\n")
    .map((line) => {
      let content = line.trimStart();
      if (content.startsWith("- ") || content.startsWith("-\t")) {
        content = content.slice(1).trimStart();
      }
      if (!content.startsWith("uses:")) {
        return line;
      }
      const scalar = content.slice("uses:".length).trimStart();
      const quote =
        scalar.startsWith('"') || scalar.startsWith("'")
          ? scalar.charAt(0)
          : "";
      const actionValue = scalar.slice(quote.length);
      if (!actionValue.startsWith("$/")) {
        return line;
      }
      let end = 0;
      while (
        end < actionValue.length &&
        !/\s|["']/u.test(actionValue.charAt(end))
      ) {
        end += 1;
      }
      const uses = actionValue.slice(0, end);
      const remainder = actionValue.slice(end);
      if (quote !== "" && !remainder.startsWith(quote)) {
        return line;
      }
      const tail = remainder.slice(quote.length).trimStart();
      if (tail !== "" && !tail.startsWith("#")) {
        return line;
      }
      rewritten.push(uses);
      const offset = line.length - scalar.length + quote.length;
      return `${line.slice(0, offset)}.${line.slice(offset + 1)}`;
    })
    .join("\n");
  if (
    JSON.stringify(rewritten.toSorted()) !== JSON.stringify(expected.toSorted())
  ) {
    throw new WorkflowYamlError({
      message: `${file}: archive action normalization must be one-to-one`,
      file,
    });
  }
  return normalized;
};

export const checkWorkflowYaml = async (root: string): Promise<void> => {
  const workflowDirectory = path.join(root, WORKFLOW_DIRECTORY);
  const workflowNames = (await readdir(workflowDirectory))
    .filter((name) =>
      YAML_EXTENSIONS.some((extension) => name.endsWith(extension)),
    )
    .toSorted();
  if (workflowNames.length === 0) {
    panic(`${WORKFLOW_DIRECTORY} contains no workflow files`);
  }
  for (const name of workflowNames) {
    const file = path.join(workflowDirectory, name);
    validateWorkflowSize(Bun.file(file).size, file);
    const value = await parseWorkflowYaml(file);
    validateWorkflowJobTimeouts(value, file);
    validateNoRubyShell(value, file);
    validateLocalActionReferences({
      value,
      root,
      file,
    });
  }

  const actionDirectory = path.join(root, ACTION_DIRECTORY);
  const actionNames = (await readdir(actionDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
  for (const name of actionNames) {
    const entries = await readdir(path.join(actionDirectory, name));
    const metadata = YAML_EXTENSIONS.map(
      (extension) => `action${extension}`,
    ).filter((file) => entries.includes(file));
    // GitHub resolves either spelling; both or neither is ambiguous or broken.
    if (metadata.length !== 1) {
      throw new WorkflowYamlError({
        message: `${path.join(ACTION_DIRECTORY, name)}: expected exactly one of action.yml or action.yaml`,
        file: path.join(actionDirectory, name),
      });
    }
    const file = path.join(
      actionDirectory,
      name,
      metadata[0] ?? panic("action metadata missing"),
    );
    const action = await parseWorkflowYaml(file);
    validateNoRubyShell(action, file);
    validateActionMetadata(action, file);
    validateLocalActionReferences({ value: action, root, file });
  }
  await validateNoRubyProcessSpawns(root);
};

if (import.meta.main) {
  await checkWorkflowYaml(path.resolve(import.meta.dirname, ".."));
}
