import { describe, expect, test } from "bun:test";

import {
  encryptAgentClientCredential,
  readAgentClientCredential,
} from "@/api/lib/agent-client-credentials";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  resetLogSinkForTesting,
  setLogSinkForTesting,
  type LogRecord,
} from "@/api/lib/observability/logger";

const credential = Buffer.alloc(32, 0x2a).toString("hex");
const alternateKey = Buffer.alloc(32, 0x2b).toString("hex");

describe("stored agent credential reads", () => {
  test("records the count of upgraded credential reads", async () => {
    const records: LogRecord[] = [];
    const upgrades: string[] = [];
    setLogSinkForTesting((record) => records.push(record));
    try {
      expect(
        await readAgentClientCredential({
          storedCredential: credential,
          upgrade: async (encrypted) => {
            upgrades.push(encrypted);
          },
        }),
      ).toBe(credential);
      expect(upgrades).toHaveLength(1);
      expect(upgrades.at(0)).toStartWith("stella-agent:v1:");
      expect(records).toEqual([
        {
          severityText: "INFO",
          message: "agent.credentials.legacy_read",
          attributes: { "migration.read_count": 1 },
        },
      ]);
      expect(JSON.stringify(records)).not.toContain(credential);
      for (const encrypted of upgrades) {
        expect(JSON.stringify(records)).not.toContain(encrypted);
      }
    } finally {
      resetLogSinkForTesting();
    }
  });

  test("requires the configured key to read an envelope", async () => {
    const storedCredential = await encryptAgentClientCredential(credential);
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "--preload",
        "./src/tests/setup-env.ts",
        "--eval",
        `
          import { Result } from "better-result";
          import { readAgentClientCredential } from "./src/lib/agent-client-credentials.ts";
          import { HandlerError } from "./src/lib/errors/tagged-errors.ts";
          let upgrades = 0;
          const result = await Result.tryPromise({try: () => readAgentClientCredential({
            storedCredential: process.env.STORED_AGENT_TEST_CREDENTIAL,
            upgrade: async () => { upgrades += 1; },
          }), catch: (cause) => cause});
          if (Result.isError(result) && result.error instanceof HandlerError &&
              result.error.message === "Could not read stored agent credential" && upgrades === 0) {
            process.stdout.write("credential read refused");
          } else {
            process.exitCode = 1;
          }
        `,
      ],
      cwd: new URL("../../", import.meta.url).pathname,
      env: {
        ...process.env,
        CONTENT_ENCRYPTION_KEY:
          process.env["CONTENT_ENCRYPTION_KEY"] === alternateKey
            ? Buffer.alloc(32, 0x2c).toString("hex")
            : alternateKey,
        STORED_AGENT_TEST_CREDENTIAL: storedCredential,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, errors).toBe(0);
    expect(output).toBe("credential read refused");
    expect(errors).not.toContain(credential);
    expect(errors).not.toContain(storedCredential);
  });

  test("requires a configured key before storing or upgrading a credential", async () => {
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "--preload",
        "./src/tests/setup-env.ts",
        "--eval",
        `
          import { Result } from "better-result";
          import { encryptAgentClientCredential, readAgentClientCredential } from "./src/lib/agent-client-credentials.ts";
          import { HandlerError } from "./src/lib/errors/tagged-errors.ts";
          const credential = Buffer.alloc(32, 0x2a).toString("hex");
          let upgrades = 0;
          const write = await Result.tryPromise({try: () => encryptAgentClientCredential(credential), catch: (cause) => cause});
          const read = await Result.tryPromise({try: () => readAgentClientCredential({
            storedCredential: credential,
            upgrade: async () => { upgrades += 1; },
          }), catch: (cause) => cause});
          const refused = (result) => Result.isError(result) && result.error instanceof HandlerError &&
            result.error.message === "Could not secure agent credentials";
          if (refused(write) && refused(read) && upgrades === 0) {
            process.stdout.write("credential storage refused");
          } else {
            process.exitCode = 1;
          }
        `,
      ],
      cwd: new URL("../../", import.meta.url).pathname,
      env: { ...process.env, CONTENT_ENCRYPTION_KEY: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, errors).toBe(0);
    expect(output).toContain("credential storage refused");
    expect(output).not.toContain(credential);
    expect(errors).not.toContain(credential);
  });

  test("requires the stored-value update to complete", async () => {
    const failure = new HandlerError({
      status: 500,
      message: "Credential update unavailable",
    });
    await expect(
      readAgentClientCredential({
        storedCredential: credential,
        upgrade: async () => {
          throw failure;
        },
      }),
    ).rejects.toThrow("Credential update unavailable");
  });

  test("requires a supported stored credential format", async () => {
    for (const storedCredential of ["stella-agent:v2:", "stella-agent:v1:"]) {
      let upgrades = 0;
      await expect(
        readAgentClientCredential({
          storedCredential,
          upgrade: async () => {
            upgrades += 1;
          },
        }),
      ).rejects.toThrow("Stored agent credential is invalid");
      expect(upgrades).toBe(0);
    }
  });
});
