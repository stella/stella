import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { flattenWorkflowSteps } from "./workflow-steps";

// A `steps.<id>` expression that names no step in its job evaluates to an
// empty value, so a condition built on it silently never holds. Every
// reference must name a step declared in the same job or composite action.

const ROOT = path.resolve(import.meta.dir, "..");
// The step context only: `needs.steps.outputs` names a job called "steps".
const STEP_REFERENCE = /(?<![\w.-])steps\.([A-Za-z_][\w-]*)\./gu;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stepIds = (steps: unknown): Set<string> =>
  new Set(
    flattenWorkflowSteps(Array.isArray(steps) ? steps : []).flatMap((step) =>
      typeof step["id"] === "string" ? [step["id"]] : [],
    ),
  );

const referencedIds = (scope: unknown): Set<string> =>
  new Set(
    [...JSON.stringify(scope).matchAll(STEP_REFERENCE)].flatMap(([, id]) =>
      id === undefined ? [] : [id],
    ),
  );

const missing = (owner: string, scope: unknown, steps: unknown): string[] => {
  const declared = stepIds(steps);
  return [...referencedIds(scope)]
    .filter((id) => !declared.has(id))
    .toSorted()
    .map((id) => `${owner}: steps.${id} names no step in this scope`);
};

/** Dangling `steps.<id>` references in one parsed workflow or action file. */
export const danglingStepReferences = (
  file: string,
  document: unknown,
): string[] => {
  if (!isRecord(document)) {
    return [];
  }
  const runs = document["runs"];
  if (isRecord(runs)) {
    // Composite action: outputs and steps share one step scope.
    return missing(file, { outputs: document["outputs"], runs }, runs["steps"]);
  }
  const jobs = document["jobs"];
  if (!isRecord(jobs)) {
    return [];
  }
  return Object.entries(jobs).flatMap(([name, job]) =>
    isRecord(job) ? missing(`${file}: job ${name}`, job, job["steps"]) : [],
  );
};

const repositoryFiles = (): string[] => {
  const workflows = readdirSync(path.join(ROOT, ".github/workflows"))
    .filter((name) => /\.ya?ml$/u.test(name))
    .map((name) => `.github/workflows/${name}`);
  const actions = readdirSync(path.join(ROOT, ".github/actions"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      ["action.yml", "action.yaml"]
        .map((name) => `.github/actions/${entry.name}/${name}`)
        .filter((file) => {
          try {
            readFileSync(path.join(ROOT, file));
            return true;
          } catch {
            return false;
          }
        }),
    );
  return [...workflows, ...actions].toSorted();
};

describe("workflow step references", () => {
  test("every steps.<id> reference names a step in the same job or action", () => {
    const problems = repositoryFiles().flatMap((file) =>
      danglingStepReferences(
        file,
        Bun.YAML.parse(readFileSync(path.join(ROOT, file), "utf-8")),
      ),
    );
    expect(problems).toEqual([]);
  });

  test("reports a condition on a step id the job does not declare", () => {
    const workflow = {
      jobs: {
        promote: {
          steps: [
            { id: "smoke-deps", run: "bun install" },
            {
              id: "mcp-smoke",
              if: `\${{ steps.current.outputs.promoted == 'true' && steps.smoke-deps.conclusion == 'success' }}`,
              run: "bun run canary:mcp",
            },
          ],
        },
      },
    };
    expect(danglingStepReferences("deploy.yml", workflow)).toEqual([
      "deploy.yml: job promote: steps.current names no step in this scope",
    ]);
  });

  test("resolves ids between nested parallel siblings and still reports missing ids", () => {
    const workflow = {
      jobs: {
        deploy: {
          steps: [
            {
              parallel: [
                { id: "restore", run: "bun restore" },
                {
                  id: "verify",
                  if: `\${{ steps.restore.outcome == 'success' && steps.absent.outcome == 'success' }}`,
                  run: "bun verify",
                },
              ],
            },
          ],
        },
      },
    };

    expect(danglingStepReferences("deploy.yml", workflow)).toEqual([
      "deploy.yml: job deploy: steps.absent names no step in this scope",
    ]);
  });

  test("checks job outputs and does not borrow ids from other jobs", () => {
    const workflow = {
      jobs: {
        resolve: {
          outputs: { sha: `\${{ steps.pick.outputs.sha }}` },
          steps: [{ id: "pick", run: "true" }],
        },
        deploy: {
          outputs: { url: `\${{ steps.pick.outputs.url }}` },
          steps: [{ id: "push", run: "true" }],
        },
      },
    };
    expect(danglingStepReferences("deploy.yml", workflow)).toEqual([
      "deploy.yml: job deploy: steps.pick names no step in this scope",
    ]);
  });

  test("ignores a job named steps in the needs context", () => {
    const workflow = {
      jobs: {
        deploy: {
          if: `\${{ needs.steps.outputs.ready == 'true' }}`,
          steps: [{ id: "push", run: "true" }],
        },
      },
    };
    expect(danglingStepReferences("deploy.yml", workflow)).toEqual([]);
  });

  test("checks composite action outputs against the action's steps", () => {
    const action = {
      outputs: { hit: { value: `\${{ steps.restore.outputs.hit }}` } },
      runs: { using: "composite", steps: [{ id: "save", run: "true" }] },
    };
    expect(danglingStepReferences("action.yml", action)).toEqual([
      "action.yml: steps.restore names no step in this scope",
    ]);
  });
});
