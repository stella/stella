import { describe, expect, test } from "bun:test";

const converterEnv = {
  GOTENBERG_URL: "https://converter.example.test",
  GOTENBERG_USERNAME: "fixture-user",
  GOTENBERG_PASSWORD: "fixture-password",
};
const moduleUrl = new URL("env-converter.ts", import.meta.url).href;
const validate = (env: Record<string, string> = converterEnv) =>
  Bun.spawnSync({
    cmd: [
      process.execPath,
      "--no-env-file",
      "-e",
      `import ${JSON.stringify(moduleUrl)};`,
    ],
    cwd: new URL("../../..", import.meta.url).pathname,
    env,
    stderr: "pipe",
  });

describe("converter environment boundary", () => {
  test("requires only converter configuration", () => {
    expect(validate().exitCode).toBe(0);
    const { GOTENBERG_USERNAME: _username, ...missingUsername } = converterEnv;
    expect(validate(missingUsername).exitCode).not.toBe(0);
  });

  test("keeps the secure service URL rule outside local development", () => {
    const insecure = {
      ...converterEnv,
      GOTENBERG_URL: "http://converter.example.test",
    };
    expect(validate(insecure).stderr.toString()).toContain(
      "GOTENBERG_URL must use HTTPS",
    );
    expect(
      validate({ ...insecure, NODE_ENV: "test", STELLA_LOCAL_DEV: "1" })
        .exitCode,
    ).toBe(0);
    expect(
      validate({ ...converterEnv, GOTENBERG_URL: "http://127.0.0.1:3000" })
        .exitCode,
    ).toBe(0);
  });
});
