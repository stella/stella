import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import {
  DEPLOY_ENV_CONTRACT,
  DEPLOY_TASK_ADDRESSES,
} from "../apps/api/src/deploy-env-contract";

const ENVIRONMENTS = ["staging", "production"] as const;
const taskNamesSchema = v.object({
  environment: v.array(v.string()),
  secrets: v.array(v.string()),
});
const projectionSchema = v.object({
  version: v.literal(1),
  environments: v.object({
    staging: v.record(v.string(), taskNamesSchema),
    production: v.record(v.string(), taskNamesSchema),
  }),
});

class DeployEnvReadError extends TaggedError("DeployEnvReadError")<{
  message: string;
}> {}

const github = async (args: string[]) => {
  const child = Bun.spawn(["bash", `${import.meta.dir}/gh-retry.sh`, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    // Never forward remote output: only names in the validated contract are reported.
    throw new DeployEnvReadError({
      message: "Deployment names projection is unreadable",
    });
  }
  return stdout.trim();
};

const readProjection = async () => {
  const repository =
    process.env["GITHUB_REPOSITORY"] ??
    (await github([
      "repo",
      "view",
      "--json",
      "nameWithOwner",
      "--jq",
      ".nameWithOwner",
    ]));
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) {
    throw new DeployEnvReadError({
      message: "Repository identity is unavailable",
    });
  }
  const deployRepository = await github([
    "api",
    `repos/${repository}/actions/variables/STAGING_DEPLOY_REPOSITORY`,
    "--jq",
    ".value",
  ]);
  if (!/^[\w.-]+$/u.test(deployRepository)) {
    throw new DeployEnvReadError({
      message: "Deployment repository setting is unavailable",
    });
  }
  const owner = repository.split("/").at(0);
  return await github([
    "api",
    `repos/${owner}/${deployRepository}/contents/scripts/lints/config-names.json?ref=main`,
    "--header",
    "Accept: application/vnd.github.raw+json",
  ]);
};

export const checkDeployEnvContract = async (
  read: () => Promise<string> = readProjection,
) => {
  const result = await Result.tryPromise({
    try: async () => v.parse(projectionSchema, JSON.parse(await read())),
    catch: () =>
      "deploy-env-contract: unreadable or invalid version 1 names projection",
  });
  if (Result.isError(result)) {
    return { exitCode: 1, lines: [result.error] };
  }
  const problems: string[] = [];
  for (const environment of ENVIRONMENTS) {
    const tasks = result.value.environments[environment];
    for (const [task, address] of Object.entries(DEPLOY_TASK_ADDRESSES)) {
      if (!Object.hasOwn(tasks, address)) {
        problems.push(
          `${environment} ${task} task-address expected ${address}`,
        );
      }
    }
    for (const { name, tasks: requiredTasks, kind } of DEPLOY_ENV_CONTRACT) {
      for (const task of requiredTasks) {
        const names = tasks[DEPLOY_TASK_ADDRESSES[task]];
        const present =
          names !== undefined &&
          (kind === "either"
            ? names.environment.includes(name) || names.secrets.includes(name)
            : names[kind].includes(name));
        if (!present) {
          problems.push(`${environment} ${task} ${name} expected ${kind}`);
        }
      }
    }
  }
  return problems.length > 0
    ? { exitCode: 1, lines: problems }
    : {
        exitCode: 0,
        lines: [
          "deploy-env-contract: staging and production task settings complete",
        ],
      };
};

if (import.meta.main) {
  const result = await checkDeployEnvContract();
  for (const line of result.lines) {
    console.log(line);
  }
  process.exit(result.exitCode);
}
