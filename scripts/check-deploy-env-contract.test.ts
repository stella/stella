import { describe, expect, test } from "bun:test";

import { BULLMQ_QUEUE_HOSTS } from "../apps/api/src/bullmq-queue-hosts";
import {
  DEPLOY_ENV_CONTRACT,
  DEPLOY_TASK_ADDRESSES,
  DEPLOY_WORKER_HOSTS,
} from "../apps/api/src/deploy-env-contract";
import { checkDeployEnvContract } from "./check-deploy-env-contract";
import { ENV_CATALOG, ENV_OWNER, ENV_REQUIREMENT } from "./env-catalog";

const fixture = () => {
  const tasks = () =>
    Object.fromEntries(
      Object.entries(DEPLOY_TASK_ADDRESSES).map(([task, address]) => [
        address,
        {
          containers: Object.values(DEPLOY_WORKER_HOSTS)
            .flat()
            .filter((location) => location.address === address)
            .map(({ container }) => container)
            .toSorted(),
          environment: DEPLOY_ENV_CONTRACT.filter(
            (entry) =>
              entry.tasks.some((required) => required === task) &&
              entry.kind !== "secrets",
          ).map(({ name }) => name),
          secrets: DEPLOY_ENV_CONTRACT.filter(
            (entry) =>
              entry.tasks.some((required) => required === task) &&
              entry.kind === "secrets",
          ).map(({ name }) => name),
        },
      ]),
    );
  return {
    version: 1,
    environments: { staging: tasks(), production: tasks() },
  };
};
const run = async (value: unknown) =>
  await checkDeployEnvContract(async () => JSON.stringify(value));
const apiNames = (value: ReturnType<typeof fixture>) => {
  const names = value.environments.production[DEPLOY_TASK_ADDRESSES.api];
  if (!names) {
    throw new Error("Fixture must include production API");
  }
  return names;
};

describe("deployment setting contract", () => {
  test("complete names pass for both environments and every task", async () => {
    expect(await run(fixture())).toEqual({
      exitCode: 0,
      lines: [
        "deploy-env-contract: staging and production task settings complete",
      ],
    });
  });

  test("reports all settings missing only from production", async () => {
    const value = fixture();
    apiNames(value).environment = apiNames(value).environment.filter(
      (name) => !["DEPLOY_ENVIRONMENT", "DATABASE_URL"].includes(name),
    );
    const result = await run(value);
    expect(result.exitCode).toBe(1);
    expect(result.lines).toEqual([
      "production api DEPLOY_ENVIRONMENT expected environment",
      "production api DATABASE_URL expected either, or all of DB_HOST,DB_PORT,DB_USER,DB_PASSWORD,DB_NAME",
    ]);
  });

  test("either accepts a secrets-only setting", async () => {
    const value = fixture();
    const names = apiNames(value);
    names.environment = names.environment.filter(
      (name) => name !== "DATABASE_URL",
    );
    names.secrets.push("DATABASE_URL");
    expect((await run(value)).exitCode).toBe(0);
  });

  test("environment and secrets requirements do not accept the wrong kind", async () => {
    const value = fixture();
    const names = apiNames(value);
    names.environment = names.environment.filter(
      (name) => name !== "DEPLOY_ENVIRONMENT",
    );
    names.secrets.push("DEPLOY_ENVIRONMENT");
    names.secrets = names.secrets.filter(
      (name) => name !== "OPENROUTER_FAST_TIER_API_KEY",
    );
    names.environment.push("OPENROUTER_FAST_TIER_API_KEY");
    expect((await run(value)).lines).toEqual([
      "production api DEPLOY_ENVIRONMENT expected environment",
      "production api OPENROUTER_FAST_TIER_API_KEY expected secrets",
    ]);
  });

  test("a queue whose consumer container is not deployed refuses, naming queue, container and task", async () => {
    const value = fixture();
    const names = apiNames(value);
    names.containers = ["api"];
    const result = await run(value);
    expect(result.exitCode).toBe(1);
    expect(result.lines).toEqual([
      `production queue file-derivatives needs container file-derivative-worker in ${DEPLOY_TASK_ADDRESSES.api} (stella-infra modules/ecs)`,
    ]);
    names.containers = ["api", "file-derivative-worker"];
    expect((await run(value)).exitCode).toBe(0);
  });

  test("a missing task address refuses the queues it alone hosts", async () => {
    const value = fixture();
    value.environments.production = Object.fromEntries(
      Object.entries(value.environments.production).filter(
        ([address]) => address !== DEPLOY_TASK_ADDRESSES.api,
      ),
    );
    const result = await run(value);
    expect(result.exitCode).toBe(1);
    expect(result.lines).toContain(
      `production queue file-derivatives needs container file-derivative-worker in ${DEPLOY_TASK_ADDRESSES.api} (stella-infra modules/ecs)`,
    );
  });

  test("document processing runs in either of its tasks", async () => {
    const ocr = "module.ecs.aws_ecs_task_definition.ocr_worker";
    const value = fixture();
    const production = Object.fromEntries(
      Object.entries(value.environments.production).filter(
        ([address]) => address !== DEPLOY_TASK_ADDRESSES["document-processing"],
      ),
    );
    value.environments.production = production;
    const refused = await run(value);
    expect(refused.lines).toContain(
      `production queue document-processing needs container document-processing in ${DEPLOY_TASK_ADDRESSES["document-processing"]} or container document-processing-worker in ${ocr} (stella-infra modules/ecs)`,
    );
    production[ocr] = {
      environment: [],
      secrets: [],
      containers: ["document-processing-worker", "ocr"],
    };
    const accepted = await run(value);
    expect(accepted.lines).not.toContainEqual(
      expect.stringContaining("queue document-processing "),
    );
  });

  test("every queue resolves to at least one task address and container", () => {
    for (const host of Object.values(BULLMQ_QUEUE_HOSTS)) {
      expect(DEPLOY_WORKER_HOSTS[host].length, host).toBeGreaterThan(0);
      for (const { address, container } of DEPLOY_WORKER_HOSTS[host]) {
        expect(address, host).toStartWith(
          "module.ecs.aws_ecs_task_definition.",
        );
        expect(container, host).not.toBe("");
      }
    }
  });

  test("a projection without containers is invalid", async () => {
    const withoutContainers = (
      tasks: ReturnType<typeof fixture>["environments"]["production"],
    ) =>
      Object.fromEntries(
        Object.entries(tasks).map(([address, { environment, secrets }]) => [
          address,
          { environment, secrets },
        ]),
      );
    const value = fixture();
    const stripped = {
      version: 1,
      environments: {
        staging: withoutContainers(value.environments.staging),
        production: withoutContainers(value.environments.production),
      },
    };
    expect(await run(stripped)).toEqual({
      exitCode: 1,
      lines: [
        "deploy-env-contract: unreadable or invalid version 1 names projection",
      ],
    });
  });

  test("absent task addresses refuse instead of skipping the task", async () => {
    const value = fixture();
    value.environments.production = Object.fromEntries(
      Object.entries(value.environments.production).filter(
        ([address]) => address !== DEPLOY_TASK_ADDRESSES.api,
      ),
    );
    const result = await run(value);
    expect(result.exitCode).toBe(1);
    expect(result.lines).toContain(
      `production api task-address expected ${DEPLOY_TASK_ADDRESSES.api}`,
    );
    expect(result.lines).toContain(
      "production api DEPLOY_ENVIRONMENT expected environment",
    );
  });

  for (const value of [{ ...fixture(), version: 2 }, { version: 1 }, null]) {
    test(`invalid projection refuses: ${JSON.stringify(value).slice(0, 30)}`, async () => {
      expect((await run(value)).exitCode).toBe(1);
    });
  }

  test("unreadable and non-JSON projections refuse without exposing input", async () => {
    const plantedValue = "fixture-private-value-123";
    for (const read of [
      async () => {
        throw new Error(plantedValue);
      },
      async () => plantedValue,
    ]) {
      const result = await checkDeployEnvContract(read);
      expect(result.exitCode).toBe(1);
      expect(result.lines.join("\n")).not.toContain(plantedValue);
    }
  });

  test("diagnostics contain only contract names, never unknown projection content", async () => {
    const value = fixture();
    const plantedValue = "fixture-private-value-123";
    apiNames(value).environment = [plantedValue];
    const result = await run(value);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).not.toContain(plantedValue);
    expect(result.lines).toContain(
      "production api DEPLOY_ENVIRONMENT expected environment",
    );
  });

  test("a deployment may carry the database components instead of the URL", async () => {
    const value = fixture();
    const components = [
      "DB_HOST",
      "DB_PORT",
      "DB_USER",
      "DB_PASSWORD",
      "DB_NAME",
    ];
    for (const environment of [
      value.environments.staging,
      value.environments.production,
    ]) {
      for (const names of Object.values(environment)) {
        names.environment = names.environment.filter(
          (name) => name !== "DATABASE_URL",
        );
        names.secrets.push(...components);
      }
    }
    expect((await run(value)).exitCode).toBe(0);
    // One component short of the set is not a database connection.
    apiNames(value).secrets = apiNames(value).secrets.filter(
      (name) => name !== "DB_PASSWORD",
    );
    const refused = await run(value);
    expect(refused.exitCode).toBe(1);
    expect(refused.lines).toContain(
      "production api DATABASE_URL expected either, or all of DB_HOST,DB_PORT,DB_USER,DB_PASSWORD,DB_NAME",
    );
  });

  test("every required API catalog name is contracted and every contract name is catalogued", () => {
    const catalogNames = new Set(ENV_CATALOG.map(({ name }) => name));
    const contractNames = new Set(DEPLOY_ENV_CONTRACT.map(({ name }) => name));
    for (const entry of ENV_CATALOG) {
      if (
        entry.requirement === ENV_REQUIREMENT.required &&
        (entry.owner === ENV_OWNER.apiBase ||
          entry.owner === ENV_OWNER.apiServer)
      ) {
        expect(contractNames.has(entry.name), entry.name).toBe(true);
      }
    }
    for (const { name, alternatives = [] } of DEPLOY_ENV_CONTRACT) {
      expect(catalogNames.has(name), name).toBe(true);
      for (const alternative of alternatives.flat()) {
        expect(catalogNames.has(alternative), alternative).toBe(true);
      }
    }
    expect(contractNames.size).toBe(DEPLOY_ENV_CONTRACT.length);
  });
});
