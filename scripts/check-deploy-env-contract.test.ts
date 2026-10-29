import { describe, expect, test } from "bun:test";

import {
  DEPLOY_ENV_CONTRACT,
  DEPLOY_TASK_ADDRESSES,
} from "../apps/api/src/deploy-env-contract";
import { checkDeployEnvContract } from "./check-deploy-env-contract";
import { ENV_CATALOG, ENV_OWNER, ENV_REQUIREMENT } from "./env-catalog";

const fixture = () => {
  const tasks = () =>
    Object.fromEntries(
      Object.entries(DEPLOY_TASK_ADDRESSES).map(([task, address]) => [
        address,
        {
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
      "production api DATABASE_URL expected either",
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
    test(`invalid projection refuses: ${JSON.stringify(value)?.slice(0, 30)}`, async () => {
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
    for (const { name } of DEPLOY_ENV_CONTRACT) {
      expect(catalogNames.has(name), name).toBe(true);
    }
    expect(contractNames.size).toBe(DEPLOY_ENV_CONTRACT.length);
  });
});
