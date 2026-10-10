#!/usr/bin/env bun

import { panic, TaggedError } from "better-result";
import { readdir } from "node:fs/promises";
import path from "node:path";

const WORKFLOW_DIRECTORY = ".github/workflows";
const ACTION_DIRECTORY = ".github/actions";

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
      message: `${file}: composite action ${field} must be a nonempty string`,
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

export const validateCompositeAction = (value: unknown, file: string): void => {
  if (!isRecord(value)) {
    throw new WorkflowYamlError({
      message: `${file}: composite action metadata must be a mapping`,
      file,
    });
  }
  requireNonemptyString(value, "name", file);
  requireNonemptyString(value, "description", file);

  const runs = value["runs"];
  if (!isRecord(runs) || runs["using"] !== "composite") {
    throw new WorkflowYamlError({
      message: `${file}: runs.using must be composite`,
      file,
    });
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
      (typeof step["shell"] !== "string" || step["shell"].trim() === "")
    ) {
      throw new WorkflowYamlError({
        message: `${file}: runs.steps[${index}] has run but no shell`,
        file,
      });
    }
  }
};

const YAML_EXTENSIONS = [".yml", ".yaml"] as const;

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
    await parseWorkflowYaml(path.join(workflowDirectory, name));
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
    validateCompositeAction(action, file);
  }
};

if (import.meta.main) {
  await checkWorkflowYaml(path.resolve(import.meta.dirname, ".."));
}
