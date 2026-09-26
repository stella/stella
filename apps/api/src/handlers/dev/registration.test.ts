import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import api from "@/api/server";

const LOCAL_DEV_PATHS = ["/dev-public/last-otp", "/v1/dev/seed"] as const;

const isLocalDevPath = (path: string) =>
  path.startsWith("/dev-public/") || path.startsWith("/v1/dev/");

const serverModuleUrl = new URL("../../server.ts", import.meta.url).href;
const apiRoot = new URL("../../..", import.meta.url).pathname;

// A complete strict configuration: loopback services, a content key, no
// local development opt-in.
const strictEnvironment = {
  PATH: process.env["PATH"] ?? "",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3001",
  CONTENT_ENCRYPTION_KEY: "a".repeat(64),
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/stella",
  FRONTEND_URL: "http://localhost:3000",
  GOTENBERG_PASSWORD: "test",
  GOTENBERG_URL: "http://localhost:3002",
  GOTENBERG_USERNAME: "test",
  NODE_ENV: "production",
  REDIS_URL: "redis://localhost:6379",
  S3_BUCKET: "stella-test",
  S3_ENDPOINT: "http://localhost:9000",
  S3_REGION: "us-east-1",
} as const;

const ROUTE_PATHS_SCRIPT = `const { default: api } = await import(${JSON.stringify(serverModuleUrl)});
process.stdout.write(JSON.stringify(api.routes.map(({ path }) => path)));
process.exit(0);`;

describe("local development routes", () => {
  test("are registered when local development access is open", () => {
    const paths = api.routes.map(({ path }) => path);

    for (const path of LOCAL_DEV_PATHS) {
      expect(paths).toContain(path);
    }
  });

  test("are absent from a strict runtime", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "--no-env-file", "-e", ROUTE_PATHS_SCRIPT],
      cwd: apiRoot,
      env: strictEnvironment,
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const paths: unknown = JSON.parse(result.stdout.toString());
    if (!Array.isArray(paths)) {
      panic("expected the route paths as an array");
    }
    // The fixture reached route registration at all.
    expect(paths).toContain("/health");
    expect(
      paths.filter(
        (path): path is string =>
          typeof path === "string" && isLocalDevPath(path),
      ),
    ).toEqual([]);
  }, 60_000);
});
