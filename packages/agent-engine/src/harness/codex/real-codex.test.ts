import { Result } from "better-result";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { createDetached } from "@stll/errors";

import { startAppServer } from "./app-server-client";
import {
  CODEX_ITEM_POLICY,
  CODEX_NOTIFICATIONS,
  CODEX_SERVER_REQUESTS,
  InitializeResponseSchema,
} from "./protocol";
import { CODEX_APPROVAL_OPTIONS } from "./turn";

/**
 * Checks against a real `codex` CLI when one is installed. Nothing here
 * signs in or sends a prompt: the handshake is `initialize` only, and the
 * protocol schema comes from `codex app-server generate-json-schema`, which
 * runs offline. Without a CLI the suite is skipped.
 */

const codex = Bun.which("codex");
const root = mkdtempSync(path.join(tmpdir(), "stella-real-codex-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Client methods the adapter calls. */
const CLIENT_METHODS = [
  "initialize",
  "account/read",
  "model/list",
  "thread/start",
  "thread/resume",
  "thread/unarchive",
  "turn/start",
  "turn/interrupt",
] as const;

const OneOfMethods = v.object({
  oneOf: v.array(
    v.object({
      properties: v.object({
        method: v.object({ enum: v.tuple([v.string()]) }),
      }),
    }),
  ),
});

const DecisionSchema = v.object({
  definitions: v.record(
    v.string(),
    v.object({
      oneOf: v.optional(
        v.array(v.object({ enum: v.optional(v.array(v.string())) })),
      ),
    }),
  ),
});

const ThreadItemTypes = v.object({
  definitions: v.object({
    ThreadItem: v.object({
      oneOf: v.array(
        v.object({
          properties: v.object({
            type: v.object({ enum: v.tuple([v.string()]) }),
          }),
        }),
      ),
    }),
  }),
});

const readJson = async (directory: string, file: string): Promise<unknown> =>
  Bun.file(path.join(directory, file)).json();

const methodsIn = async (directory: string, file: string) =>
  v
    .parse(OneOfMethods, await readJson(directory, file))
    .oneOf.map(({ properties }) => properties.method.enum[0]);

const decisionsIn = async (directory: string, file: string, name: string) =>
  (
    v.parse(DecisionSchema, await readJson(directory, file)).definitions[name]
      ?.oneOf ?? []
  ).flatMap(({ enum: values }) => values ?? []);

describe.skipIf(codex === null)("the installed codex CLI", () => {
  test("completes the initialize handshake with a stella-owned home", async () => {
    const codexHome = path.join(root, "home");
    const backgroundErrors: unknown[] = [];
    mkdirSync(codexHome);
    const client = startAppServer({
      launch: { executable: codex ?? "", args: ["app-server"] },
      detached: createDetached((error) => {
        backgroundErrors.push(error);
      }),
      cwd: root,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        CODEX_HOME: codexHome,
      },
      handlers: {
        notification: () => undefined,
        request: () => undefined,
        violation: () => undefined,
        exit: () => undefined,
      },
    });
    const initialized = await client.request("initialize", {
      clientInfo: { name: "stella", title: "stella", version: "0.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    await client.kill();
    expect(backgroundErrors).toEqual([]);
    if (Result.isError(initialized)) {
      throw initialized.error;
    }
    const parsed = v.parse(InitializeResponseSchema, initialized.value);
    expect(parsed.codexHome).toContain("home");
    expect(parsed.userAgent).toMatch(/^stella\/\d+\.\d+\.\d+/u);
  });

  test("the protocol still has every method, item kind and decision the adapter relies on", async () => {
    const out = path.join(root, "schema");
    const generated = Bun.spawnSync([
      codex ?? "",
      "app-server",
      "generate-json-schema",
      "--out",
      out,
    ]);
    expect(generated.exitCode).toBe(0);

    const serverRequests = await methodsIn(out, "ServerRequest.json");
    expect(new Set(serverRequests)).toEqual(
      new Set(Object.keys(CODEX_SERVER_REQUESTS)),
    );

    const notifications = new Set(
      await methodsIn(out, "ServerNotification.json"),
    );
    for (const method of Object.keys(CODEX_NOTIFICATIONS)) {
      expect(notifications.has(method)).toBe(true);
    }

    const clientMethods = new Set(await methodsIn(out, "ClientRequest.json"));
    for (const method of CLIENT_METHODS) {
      expect(clientMethods.has(method)).toBe(true);
    }

    const itemTypes = v
      .parse(
        ThreadItemTypes,
        await readJson(out, "codex_app_server_protocol.v2.schemas.json"),
      )
      .definitions.ThreadItem.oneOf.map(
        ({ properties }) => properties.type.enum[0],
      );
    expect(new Set(itemTypes)).toEqual(new Set(Object.keys(CODEX_ITEM_POLICY)));

    const commandDecisions = await decisionsIn(
      out,
      "CommandExecutionRequestApprovalResponse.json",
      "CommandExecutionApprovalDecision",
    );
    const fileDecisions = await decisionsIn(
      out,
      "FileChangeRequestApprovalResponse.json",
      "FileChangeApprovalDecision",
    );
    for (const { id } of CODEX_APPROVAL_OPTIONS) {
      expect(commandDecisions).toContain(id);
      expect(fileDecisions).toContain(id);
    }
  });
});
