import { describe, expect, test } from "bun:test";
import nodeOs from "node:os";
import nodePath from "node:path";

/** Run the minting script without the app environment, as an operator would. */
const runMint = async (extraEnv: Record<string, string> = {}) => {
  // Without an explicit empty `--env-file`, Bun loads `apps/api/.env` from
  // the working directory and the app environment leaks back in.
  const emptyEnvFile = nodePath.join(
    nodeOs.tmpdir(),
    "stella-partner-client-secret-empty.env",
  );
  await Bun.write(emptyEnvFile, "");
  return Bun.spawnSync({
    cmd: [
      process.execPath,
      `--env-file=${emptyEnvFile}`,
      new URL("partner-oauth-client-secret.ts", import.meta.url).pathname,
    ],
    env: { HOME: process.env["HOME"], PATH: process.env["PATH"], ...extraEnv },
  });
};

describe("partner client secret minting", () => {
  // A spawned child has no terminal, the shape of a logged server run.
  test("refuses without an interactive terminal and prints no secret", async () => {
    const run = await runMint();
    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString()).toBe("");
    expect(run.stderr.toString()).toContain("never in a server task");
  });

  test("refuses inside an ECS task", async () => {
    const run = await runMint({
      ECS_CONTAINER_METADATA_URI_V4: "http://169.254.170.2/v4/task",
    });
    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString()).toBe("");
  });
});
