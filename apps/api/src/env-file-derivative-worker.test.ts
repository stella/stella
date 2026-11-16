import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import {
  apiSourceRoot,
  collectApiModuleGraph,
} from "@/api/tests/api-module-graph";

const baseEnv = {
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/stella",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "stella-test",
  S3_REGION: "us-east-1",
  REDIS_URL: "redis://localhost:6379",
  GOTENBERG_URL: "http://localhost:3002",
  GOTENBERG_USERNAME: "test",
  GOTENBERG_PASSWORD: "test",
} as const;
const moduleUrl = new URL("env-file-derivative-worker.ts", import.meta.url)
  .href;
const repoRoot = new URL("../../..", import.meta.url).pathname;

const validate = (env: Record<string, string | undefined> = baseEnv) =>
  Bun.spawnSync({
    cmd: [
      process.execPath,
      "--no-env-file",
      "-e",
      `import ${JSON.stringify(moduleUrl)};`,
    ],
    cwd: repoRoot,
    env,
    stderr: "pipe",
  });

describe("file-derivative worker environment", () => {
  test("boots with only database, storage, Valkey, and converter settings", () => {
    expect(validate().exitCode).toBe(0);
  });

  test("requires Valkey and converter settings", () => {
    const { REDIS_URL: _redis, ...withoutRedis } = baseEnv;
    expect(validate(withoutRedis).stderr.toString()).toContain(
      "REDIS_URL is required",
    );
    const { GOTENBERG_URL: _gotenberg, ...withoutGotenberg } = baseEnv;
    expect(validate(withoutGotenberg).exitCode).not.toBe(0);
  });

  test("shares the background-worker mode schema", () => {
    expect(
      validate({
        ...baseEnv,
        NODE_ENV: "test",
        STELLA_LOCAL_DEV: "1",
        SCHEDULED_JOBS_MODE: "disabled",
      }).exitCode,
    ).toBe(0);
    expect(
      validate({ ...baseEnv, SCHEDULED_JOBS_MODE: "invalid" }).exitCode,
    ).not.toBe(0);
    expect(
      validate({ ...baseEnv, SCHEDULED_JOBS_MODE: "disabled" }).exitCode,
    ).not.toBe(0);
  });

  test("does not import the API environment", async () => {
    const modules = await collectApiModuleGraph(
      nodePath.resolve(apiSourceRoot, "scripts/file-derivative-worker.ts"),
    );
    expect(modules).toContain(
      nodePath.resolve(apiSourceRoot, "env-file-derivative-worker.ts"),
    );
    expect(modules).not.toContain(nodePath.resolve(apiSourceRoot, "env.ts"));
  });
});
