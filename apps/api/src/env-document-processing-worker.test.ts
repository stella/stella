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
} as const;

const workerEnvModuleUrl = new URL(
  "env-document-processing-worker.ts",
  import.meta.url,
).href;
const repoRoot = new URL("../../..", import.meta.url).pathname;
const workerEntrypoint = nodePath.resolve(
  apiSourceRoot,
  "scripts/document-processing-worker.ts",
);

const validateWorkerEnv = (env: Record<string, string | undefined> = baseEnv) =>
  Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `import ${JSON.stringify(workerEnvModuleUrl)};`,
    ],
    cwd: repoRoot,
    env,
    stderr: "pipe",
    stdout: "pipe",
  });

describe("document-processing worker environment", () => {
  test("boots without API auth, frontend, email, or Gotenberg settings", () => {
    expect(validateWorkerEnv().exitCode).toBe(0);
  });

  test("refuses to boot without a Redis endpoint", () => {
    const withoutRedis = Object.fromEntries(
      Object.entries(baseEnv).filter(([key]) => key !== "REDIS_URL"),
    );
    const result = validateWorkerEnv(withoutRedis);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("REDIS_URL is required");
  });

  test("accepts Railway private-network Redis in production", () => {
    expect(
      validateWorkerEnv({
        ...baseEnv,
        CONTENT_ENCRYPTION_KEY: "a".repeat(64),
        NODE_ENV: "production",
        REDIS_URL: "redis://default:password@redis.railway.internal:6379",
      }).exitCode,
    ).toBe(0);
  });

  test("does not pull the full API environment into the worker graph", async () => {
    const modules = await collectApiModuleGraph(workerEntrypoint);

    expect(modules).toContain(
      nodePath.resolve(apiSourceRoot, "env-document-processing-worker.ts"),
    );
    expect(modules).not.toContain(nodePath.resolve(apiSourceRoot, "env.ts"));
  });
});
