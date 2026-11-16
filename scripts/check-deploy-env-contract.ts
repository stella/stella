import { BULLMQ_QUEUE_HOSTS } from "../apps/api/src/bullmq-queue-hosts";
import {
  DEPLOY_ENV_CONTRACT,
  DEPLOY_TASK_ADDRESSES,
  DEPLOY_WORKER_HOSTS,
} from "../apps/api/src/deploy-env-contract";

// Runs from a bare checkout in the promote job, which holds release
// credentials: built-in modules only, so no dependency install is needed.
const ENVIRONMENTS = ["staging", "production"] as const;
const INVALID_PROJECTION =
  "deploy-env-contract: unreadable or invalid version 1 names projection";

type TaskNames = {
  environment: string[];
  secrets: string[];
  containers: string[];
};
type Projection = {
  staging: Map<string, TaskNames>;
  production: Map<string, TaskNames>;
};

class DeployEnvReadError extends Error {
  override name = "DeployEnvReadError";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toStrings = (value: unknown) =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value.map(String)
    : undefined;

const toTaskNames = (value: unknown): TaskNames | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const environment = toStrings(value["environment"]);
  const secrets = toStrings(value["secrets"]);
  const containers = toStrings(value["containers"]);
  return environment && secrets && containers
    ? { environment, secrets, containers }
    : undefined;
};

const toEnvironmentTasks = (value: unknown) => {
  if (!isRecord(value)) {
    return undefined;
  }
  const tasks = new Map<string, TaskNames>();
  for (const [address, names] of Object.entries(value)) {
    const parsed = toTaskNames(names);
    if (!parsed) {
      return undefined;
    }
    tasks.set(address, parsed);
  }
  return tasks;
};

const parseProjection = (raw: string): Projection | undefined => {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || value["version"] !== 1) {
    return undefined;
  }
  const environments = value["environments"];
  if (!isRecord(environments)) {
    return undefined;
  }
  const staging = toEnvironmentTasks(environments["staging"]);
  const production = toEnvironmentTasks(environments["production"]);
  return staging && production ? { staging, production } : undefined;
};

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
    throw new DeployEnvReadError("Deployment names projection is unreadable");
  }
  return stdout.trim();
};

const readNames = async (deployRepository: string) =>
  await github([
    "api",
    `repos/${deployRepository}/contents/scripts/lints/config-names.json?ref=main`,
    "--header",
    "Accept: application/vnd.github.raw+json",
  ]);

const readProjection = async () => {
  // The promote job holds a token scoped to the deployment repository alone,
  // which cannot read the variable below; it names the repository directly.
  const pinned = process.env["DEPLOY_ENV_CONTRACT_INFRA_REPOSITORY"];
  if (pinned !== undefined) {
    if (!/^[\w.-]+\/[\w.-]+$/u.test(pinned)) {
      throw new DeployEnvReadError(
        "Deployment repository setting is unavailable",
      );
    }
    return await readNames(pinned);
  }
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
    throw new DeployEnvReadError("Repository identity is unavailable");
  }
  // A workflow passes the setting from its own context; an operator's run
  // reads it from the repository.
  const deployRepository =
    process.env["STAGING_DEPLOY_REPOSITORY"] ??
    (await github([
      "api",
      `repos/${repository}/actions/variables/STAGING_DEPLOY_REPOSITORY`,
      "--jq",
      ".value",
    ]));
  if (!/^[\w.-]+$/u.test(deployRepository)) {
    throw new DeployEnvReadError(
      "Deployment repository setting is unavailable",
    );
  }
  const [owner] = repository.split("/");
  if (owner === undefined) {
    throw new DeployEnvReadError("Repository identity is unavailable");
  }
  return await readNames(`${owner}/${deployRepository}`);
};

export const checkDeployEnvContract = async (
  read: () => Promise<string> = readProjection,
) => {
  let projection: Projection | undefined;
  try {
    projection = parseProjection(await read());
  } catch {
    projection = undefined;
  }
  if (projection === undefined) {
    return { exitCode: 1, lines: [INVALID_PROJECTION] };
  }
  const problems: string[] = [];
  for (const environment of ENVIRONMENTS) {
    const tasks = projection[environment];
    for (const [task, address] of Object.entries(DEPLOY_TASK_ADDRESSES)) {
      if (!tasks.has(address)) {
        problems.push(
          `${environment} ${task} task-address expected ${address}`,
        );
      }
    }
    for (const [queue, host] of Object.entries(BULLMQ_QUEUE_HOSTS)) {
      const locations = DEPLOY_WORKER_HOSTS[host];
      const deployed = locations.some(({ address, container }) =>
        tasks.get(address)?.containers.includes(container),
      );
      if (!deployed) {
        const needs = locations
          .map(
            ({ address, container }) => `container ${container} in ${address}`,
          )
          .join(" or ");
        problems.push(
          `${environment} queue ${queue} needs ${needs} (stella-infra modules/ecs)`,
        );
      }
    }
    for (const {
      name,
      tasks: requiredTasks,
      kind,
      alternatives = [],
    } of DEPLOY_ENV_CONTRACT) {
      for (const task of requiredTasks) {
        const names = tasks.get(DEPLOY_TASK_ADDRESSES[task]);
        const has = (candidate: string) =>
          names !== undefined &&
          (kind === "either"
            ? names.environment.includes(candidate) ||
              names.secrets.includes(candidate)
            : names[kind].includes(candidate));
        const present = has(name) || alternatives.some((set) => set.every(has));
        if (!present) {
          problems.push(
            alternatives.length === 0
              ? `${environment} ${task} ${name} expected ${kind}`
              : `${environment} ${task} ${name} expected ${kind}, or all of ${alternatives
                  .map((set) => set.join(","))
                  .join(" or ")}`,
          );
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
