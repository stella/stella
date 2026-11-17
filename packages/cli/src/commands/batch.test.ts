import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runBatch } from "../batch/runner.js";
import { deriveCapabilityLeaf } from "../generate-capability-tree.js";
import { generatedRouteMap } from "../generated/route-map.js";
import { type BatchToolCall, McpClientError } from "../mcp-client.js";
import type { RouteNode } from "../route-types.js";
import { batchToolResponse, resolveBatchCommand } from "./batch.js";

const capability = (replay: "replay" | "unsupported") =>
  deriveCapabilityLeaf({
    id: "contacts.create",
    access: "write",
    destructive: false,
    handlerKind: "root",
    scope: "stella:contacts_write",
    transport: { type: "json" },
    inputSchema: {
      body: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
    ...(replay === "replay" ? { idempotency: { type: "replay" } } : {}),
  });

const OPAQUE = {
  token: "opaque",
  effectiveGrants: { type: "unknown" },
  serverUrl: undefined,
} as const;

const runWith = async (
  replay: "replay" | "unsupported",
  call: BatchToolCall,
  authorization: Parameters<
    typeof resolveBatchCommand
  >[0]["authorization"] = OPAQUE,
) => {
  const { spec } = capability(replay);
  const tree: RouteNode = {
    kind: "route",
    children: {
      contacts: {
        kind: "route",
        children: { create: { kind: "capability-leaf", spec } },
      },
    },
  };
  return await runBatch({
    source: JSON.stringify({
      command: "contacts create",
      input: { body: { name: "Fixture" } },
    }),
    resolve: (command) =>
      resolveBatchCommand({ tree, command, call, authorization, yes: false }),
    now: () => 0,
    sleep: async () => undefined,
  });
};

describe("batch command", () => {
  test("destructive native commands require confirmation and forward their declared gate", async () => {
    const calls: Parameters<BatchToolCall>[0][] = [];
    const call: BatchToolCall = async (options) => {
      calls.push(options);
      return Result.ok({ content: [{ type: "text", text: '{"result":{}}' }] });
    };
    const source = JSON.stringify({
      command: "contact delete",
      input: { contact_id: "11111111-1111-4111-8111-111111111111" },
    });
    for (const yes of [false, true]) {
      const outcome = await runBatch({
        source,
        resolve: (command) =>
          resolveBatchCommand({
            tree: generatedRouteMap,
            command,
            call,
            authorization: OPAQUE,
            yes,
          }),
        now: () => 0,
        sleep: async () => undefined,
      });
      expect(outcome.unwrap().at(0)?.status).toBe(yes ? "ok" : "error");
    }
    expect(calls).toHaveLength(1);
    expect(calls.at(0)?.args).toEqual({
      contact_id: "11111111-1111-4111-8111-111111111111",
      confirm: true,
    });
    expect(calls.at(0)?.idempotencyKey).toBeUndefined();
  });
  test("only declared replay capabilities receive stable write keys", async () => {
    const calls: Parameters<BatchToolCall>[0][] = [];
    const call: BatchToolCall = async (options) => {
      calls.push(options);
      return Result.ok({
        content: [{ type: "text", text: '{"result":{"created":true}}' }],
      });
    };
    expect((await runWith("replay", call)).unwrap().at(0)?.status).toBe("ok");
    expect((await runWith("replay", call)).unwrap().at(0)?.status).toBe("ok");
    expect(calls.at(0)?.idempotencyKey).toMatch(/^stella-batch-[a-f0-9]{64}$/u);
    expect(calls.at(0)?.idempotencyKey).toBe(calls.at(1)?.idempotencyKey);
    await runWith("unsupported", call);
    expect(calls.at(2)?.idempotencyKey).toBeUndefined();
    expect(calls.at(0)?.args).toEqual({
      capability: "contacts.create",
      input: { body: { name: "Fixture" } },
    });
  });

  test("server grants decide scope preflight, naming the same server in the login hint", async () => {
    let calls = 0;
    const call: BatchToolCall = async () => {
      calls += 1;
      return await Promise.resolve(Result.ok({ content: [] }));
    };
    const outcome = await runWith("unsupported", call, {
      token: "opaque",
      effectiveGrants: { type: "known", scopes: ["stella:contacts_read"] },
      serverUrl: "https://stella.example",
    });
    expect(calls).toBe(0);
    expect(outcome.unwrap().at(0)).toMatchObject({
      status: "error",
      error: {
        code: "missing_scope",
        message:
          "Missing scope stella:contacts_write. Re-run 'stella auth login --scopes stella:contacts_read,stella:contacts_write --server https://stella.example' to grant the complete scope set.",
      },
    });
  });

  test("uncertain writes are listed once and never retried", async () => {
    for (const kind of ["transport", "http"] as const) {
      let calls = 0;
      const outcome = await runWith("unsupported", async () => {
        calls += 1;
        return Result.err(
          new McpClientError({
            kind,
            httpStatus: 503,
            message: "Response lost",
          }),
        );
      });
      expect(calls).toBe(1);
      expect(outcome.unwrap().at(0)?.status).toBe("unknown");
    }
  });

  test("HTTP Retry-After is preserved and read failures remain errors", () => {
    expect(
      batchToolResponse(
        Result.ok({
          isError: true,
          content: [
            {
              type: "text",
              text: '{"error":{"code":"rate_limited","retryAfterMs":60000}}',
            },
          ],
        }),
        "write",
      ),
    ).toEqual({ status: "rate_limited", retryAfter: "60" });
    expect(
      batchToolResponse(
        Result.err(
          new McpClientError({
            kind: "http",
            httpStatus: 429,
            retryAfter: "3",
            message: "Slow down",
          }),
        ),
        "write",
      ),
    ).toEqual({ status: "rate_limited", retryAfter: "3" });
    expect(
      batchToolResponse(
        Result.err(
          new McpClientError({ kind: "transport", message: "Response lost" }),
        ),
        "read",
      ).status,
    ).toBe("error");
  });

  test("dry run reads stdin, reports each invalid line and performs no authentication request", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dirname, "../cli.ts"),
        "batch",
        "-",
        "--dry-run",
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, STELLA_SERVER_URL: "http://127.0.0.1:1" },
      },
    );
    await child.stdin.write(
      'bad json\n{"command":"missing command","input":{}}\n',
    );
    await child.stdin.end();
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit).not.toBe(0);
    expect(stderr).not.toContain("Not signed in");
    const lines: unknown[] = stdout
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
    expect(lines).toMatchObject([
      { line: 1, status: "error", error: { code: "invalid_json" } },
      { line: 2, status: "error", error: { code: "unknown_command" } },
    ]);
  });

  test("file dry run uses the shipped command schema and rejects invalid concurrency", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "stella-batch-command-"),
    );
    try {
      const source = path.join(directory, "ops.jsonl");
      await writeFile(source, '{"command":"contact delete","input":{}}\n');
      const execute = async (extra: string[]) => {
        const child = Bun.spawn(
          [
            process.execPath,
            path.join(import.meta.dirname, "../cli.ts"),
            "batch",
            source,
            "--dry-run",
            ...extra,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { stdout, stderr, exit };
      };
      const validation = await execute([]);
      expect(validation.exit).not.toBe(0);
      expect(JSON.parse(validation.stdout)).toMatchObject({
        line: 1,
        status: "error",
        error: { code: "invalid_input" },
      });
      const invalid = await execute(["--concurrency", "17"]);
      expect(invalid.exit).not.toBe(0);
      expect(invalid.stderr).toContain("--concurrency must be an integer");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
