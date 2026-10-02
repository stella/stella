import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  encryptAgentClientCredential,
  prepareAgentClientCredential,
  readAgentClientCredential,
} from "@/api/agent-auth/credentials";
import { env } from "@/api/env";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  resetLogSinkForTesting,
  setLogSinkForTesting,
  type LogRecord,
} from "@/api/lib/observability/logger";

let priorStorageSetting = false;
beforeEach(() => {
  priorStorageSetting = env.AGENT_CLIENT_STORAGE_V1_ENABLED;
  env.AGENT_CLIENT_STORAGE_V1_ENABLED = true;
});
afterEach(() => {
  env.AGENT_CLIENT_STORAGE_V1_ENABLED = priorStorageSetting;
});

const credential = Buffer.alloc(32, 0x2a).toString("hex");
const alternateKey = Buffer.alloc(32, 0x2b).toString("hex");

describe("stored agent credential reads", () => {
  test("selects the configured write format and accepts both read formats", async () => {
    const envelope = (await encryptAgentClientCredential(credential)).unwrap();
    for (const enabled of [false, true]) {
      env.AGENT_CLIENT_STORAGE_V1_ENABLED = enabled;
      const stored = (await prepareAgentClientCredential(credential)).unwrap();
      if (enabled) {
        expect(stored).toStartWith("stella-agent:v1:");
      } else {
        expect(stored).toBe(credential);
      }
      for (const value of [credential, envelope]) {
        const updates: string[] = [];
        expect(
          (
            await readAgentClientCredential({
              storedCredential: value,
              upgrade: async (replacement) => {
                updates.push(replacement);
                return Result.ok();
              },
            })
          ).unwrap(),
        ).toBe(credential);
        expect(updates.length).toBe(enabled && value === credential ? 1 : 0);
      }
    }
  });

  test("records the count of upgraded credential reads", async () => {
    const records: LogRecord[] = [];
    const upgrades: string[] = [];
    setLogSinkForTesting((record) => records.push(record));
    try {
      expect(
        (
          await readAgentClientCredential({
            storedCredential: credential,
            upgrade: async (encrypted) => {
              upgrades.push(encrypted);
              return Result.ok();
            },
          })
        ).unwrap(),
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
    const storedCredential = (
      await encryptAgentClientCredential(credential)
    ).unwrap();
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "--preload",
        "./src/tests/setup-env.ts",
        "--eval",
        `
          import { Result } from "better-result";
          import { readAgentClientCredential } from "./src/agent-auth/credentials.ts";
          import { HandlerError } from "./src/lib/errors/tagged-errors.ts";
          let upgrades = 0;
          const result = await readAgentClientCredential({
            storedCredential: process.env.STORED_AGENT_TEST_CREDENTIAL,
            upgrade: async () => { upgrades += 1; return Result.ok(); },
          });
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
          import { encryptAgentClientCredential, readAgentClientCredential } from "./src/agent-auth/credentials.ts";
          import { HandlerError } from "./src/lib/errors/tagged-errors.ts";
          const credential = Buffer.alloc(32, 0x2a).toString("hex");
          let upgrades = 0;
          const write = await encryptAgentClientCredential(credential);
          const read = await readAgentClientCredential({
            storedCredential: credential,
            upgrade: async () => { upgrades += 1; return Result.ok(); },
          });
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
      env: {
        ...process.env,
        CONTENT_ENCRYPTION_KEY: "",
        AGENT_CLIENT_STORAGE_V1_ENABLED: "true",
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
    expect(output).toContain("credential storage refused");
    expect(output).not.toContain(credential);
    expect(errors).not.toContain(credential);
  });

  test("requires the stored-value update to complete", async () => {
    const failure = new HandlerError({
      status: 500,
      message: "Credential update unavailable",
    });
    expect(
      await readAgentClientCredential({
        storedCredential: credential,
        upgrade: async () => Result.err(failure),
      }),
    ).toEqual(Result.err(failure));
  });

  test("requires a supported stored credential format", async () => {
    for (const storedCredential of ["stella-agent:v2:", "stella-agent:v1:"]) {
      let upgrades = 0;
      const result = await readAgentClientCredential({
        storedCredential,
        upgrade: async () => {
          upgrades += 1;
          return Result.ok();
        },
      });
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.message).toBe("Stored agent credential is invalid");
      }
      expect(upgrades).toBe(0);
    }
  });
});
