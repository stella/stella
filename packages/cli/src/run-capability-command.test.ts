import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { respondToMcpLifecycle } from "../tests/mcp-test-lifecycle.js";
import { readCapabilityCatalog } from "./capability-catalog-data.js";
import { parseCapabilityCatalog } from "./capability-catalog-load.js";
import type { Context } from "./context.js";
import {
  capabilityCommandPath,
  deriveCapabilityLeaf,
} from "./generate-capability-tree.js";
import { EXIT_CODES } from "./mcp-constants.js";
import type { CapabilityFlagSpec, CapabilityLeafSpec } from "./route-types.js";
import { runCapabilityCommand } from "./run-capability-command.js";

type RecordedCall = { name: string; args: Record<string, unknown> };

type ServerResponse =
  | { kind: "echo" }
  | { kind: "payload"; payload: unknown }
  | { kind: "error"; error: Record<string, unknown> }
  | { kind: "confirm-gate" }
  | { kind: "receipt"; requestId: string }
  | { kind: "pages"; pages: readonly Record<string, unknown>[] };

/**
 * In-process MCP endpoint. `echo` returns the received args as the result so a
 * test can assert the exact capability executor payload; `confirm-gate` answers
 * `confirmation_required` until `confirm: true`; `pages` walks a cursor list.
 */
const startServer = (response: ServerResponse) => {
  const calls: RecordedCall[] = [];
  let pageIndex = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method === "GET") {
        return new Response(null, { status: 405 });
      }
      const body: {
        method?: string;
        params: { name: string; arguments?: Record<string, unknown> };
      } = JSON.parse(await req.text());
      const lifecycle = respondToMcpLifecycle(body);
      if (lifecycle !== null) {
        return lifecycle;
      }
      const args = body.params.arguments ?? {};
      calls.push({ name: body.params.name, args });
      // As the server answers: the capability output under `result`, in
      // structuredContent and as its JSON text.
      const text = (payload: unknown): Response =>
        Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              { type: "text", text: JSON.stringify({ result: payload }) },
            ],
            structuredContent: { result: payload },
          },
        });
      if (response.kind === "payload") {
        return text(response.payload);
      }
      if (response.kind === "error") {
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: response.error }),
              },
            ],
            isError: true,
          },
        });
      }
      if (response.kind === "confirm-gate") {
        if (args["confirm"] === true) {
          return text({ done: true });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: {
                    code: "confirmation_required",
                    message: "irreversible; retry with confirm",
                  },
                }),
              },
            ],
            isError: true,
          },
        });
      }
      if (response.kind === "receipt") {
        return text({ ok: true, meta: { requestId: response.requestId } });
      }
      if (response.kind === "pages") {
        const page = response.pages[pageIndex] ?? {
          items: [],
          nextCursor: null,
        };
        pageIndex += 1;
        return text(page);
      }
      return text({ received: args });
    },
  });
  return {
    calls,
    url: server.url.origin,
    stop: () => {
      void server.stop(true);
    },
  };
};

type FakeTty = {
  context: Context;
  exitCode: () => number | string | undefined;
  stderrText: () => string;
  stdoutText: () => string;
};

const makeTtyContext = ({
  serverUrl,
  stdinData,
  isTTY,
  token = "header.payload.sig",
}: {
  serverUrl: string;
  stdinData: string;
  isTTY: boolean;
  token?: string;
}): FakeTty => {
  const stdin = Object.assign(new PassThrough(), { isTTY });
  if (stdinData.length > 0) {
    stdin.write(stdinData);
  }
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdout = Object.assign(new PassThrough(), { isTTY });
  stdout.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk.toString());
  });
  const stderr = Object.assign(new PassThrough(), { isTTY });
  stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString());
  });
  const proc = { stdin, stdout, stderr, exitCode: undefined, env: {} };
  const context: Context = {
    // SAFETY: the executor only reads stdin/stdout/stderr/exitCode off process.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double for the process slice
    process: proc as unknown as NodeJS.Process,
    configDir: "/tmp/stella-test",
    serverUrl,
    token,
  };
  return {
    context,
    exitCode: () => proc.exitCode,
    stderrText: () => stderrChunks.join(""),
    stdoutText: () => stdoutChunks.join(""),
  };
};

const makeToken = (scopes: readonly string[]): string => {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    sub: "user-1",
    exp: Math.floor(Date.now() / 1000) + 3600,
    scope: scopes.map((scope) => `stella:${scope}`).join(" "),
  })}.sig`;
};

const stringFlag = (
  flag: string,
  part: CapabilityFlagSpec["part"],
  partPath: string,
  required = false,
): CapabilityFlagSpec => ({
  flag,
  prop: flag
    .slice(2)
    .replace(/-(?<c>[a-z])/gu, (_m, c: string) => c.toUpperCase()),
  kind: "string",
  required,
  repeatable: false,
  part,
  partPath,
});

const capSpec = (
  overrides: Partial<CapabilityLeafSpec> & { capabilityId: string },
): CapabilityLeafSpec => ({
  commandPath: ["x", "y"],
  access: "read",
  flags: [],
  inputOnly: [],
  paginated: false,
  destructive: false,
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  ...overrides,
});

const lastInvoke = (calls: readonly RecordedCall[]): Record<string, unknown> =>
  calls.at(-1)?.args ?? {};

describe("runCapabilityCommand: flag -> capability executor payload", () => {
  for (const access of ["read", "write"] as const) {
    test(`${access} capability dispatches through its executor, including dry runs`, async () => {
      const server = startServer({ kind: "echo" });
      const tty = makeTtyContext({
        serverUrl: server.url,
        stdinData: "",
        isTTY: false,
      });
      await runCapabilityCommand({
        context: tty.context,
        flags: { dryRun: true },
        spec: capSpec({ capabilityId: "a.operation", access }),
      });
      server.stop();
      expect(server.calls).toEqual([
        {
          name: `${access}_capability`,
          args: { capability: "a.operation", input: {}, validate_only: true },
        },
      ]);
    });
  }

  test("routes flags into input parts and calls the write executor", async () => {
    const server = startServer({ kind: "echo" });
    const spec = capSpec({
      capabilityId: "billing-codes.create",
      access: "write",
      commandPath: ["billing-codes", "create"],
      flags: [
        stringFlag("--matter-id", "params", "matterId", true),
        stringFlag("--code", "body", "code", true),
      ],
    });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
    });
    await runCapabilityCommand({
      context: tty.context,
      flags: { matterId: "ws-1", code: "A1" },
      spec,
    });
    server.stop();
    const call = server.calls.at(0);
    expect(call?.name).toBe("write_capability");
    expect(call?.args).toEqual({
      capability: "billing-codes.create",
      input: { params: { matterId: "ws-1" }, body: { code: "A1" } },
    });
    expect(tty.exitCode()).toBeUndefined();
  });

  test("--dry-run adds validate_only: true", async () => {
    const server = startServer({ kind: "echo" });
    const spec = capSpec({
      capabilityId: "a.b",
      flags: [stringFlag("--name", "body", "name")],
    });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
    });
    await runCapabilityCommand({
      context: tty.context,
      flags: { name: "x", dryRun: true },
      spec,
    });
    server.stop();
    expect(lastInvoke(server.calls)["validate_only"]).toBe(true);
  });

  test("a missing required flag is exit 2 with no server call", async () => {
    const server = startServer({ kind: "echo" });
    const spec = capSpec({
      capabilityId: "a.b",
      flags: [stringFlag("--code", "body", "code", true)],
    });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
    });
    await runCapabilityCommand({ context: tty.context, flags: {}, spec });
    server.stop();
    expect(tty.exitCode()).toBe(EXIT_CODES.validation);
    expect(server.calls).toHaveLength(0);
    expect(tty.stderrText()).toContain("--code");
  });

  test("--input passes the whole input object through for server validation", async () => {
    const server = startServer({ kind: "echo" });
    const spec = capSpec({
      capabilityId: "a.b",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          body: {
            type: "object",
            properties: { name: { type: "string" } },
          },
        },
      },
    });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
    });
    await runCapabilityCommand({
      context: tty.context,
      flags: { input: '{"body":{"name":"ok"}}' },
      spec,
    });
    server.stop();
    expect(lastInvoke(server.calls)["input"]).toEqual({ body: { name: "ok" } });
  });

  test("--input leaves unknown-field rejection to the shared server boundary", async () => {
    const server = startServer({ kind: "echo" });
    const spec = capSpec({
      capabilityId: "a.b",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          body: {
            type: "object",
            properties: { name: { type: "string" } },
          },
        },
      },
    });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
    });
    await runCapabilityCommand({
      context: tty.context,
      flags: { input: '{"nope":1}' },
      spec,
    });
    server.stop();
    expect(tty.exitCode()).toBeUndefined();
    expect(lastInvoke(server.calls)["input"]).toEqual({ nope: 1 });
  });

  test("value flags COMPOSE with --input; the explicit flag wins over its path", async () => {
    const server = startServer({ kind: "echo" });
    const spec = capSpec({
      capabilityId: "uploads.create",
      flags: [stringFlag("--matter-id", "params", "matterId", true)],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          body: {
            type: "object",
            additionalProperties: false,
            properties: { purpose: { type: "string" } },
          },
          params: {
            type: "object",
            additionalProperties: false,
            properties: { matterId: { type: "string" } },
          },
        },
      },
    });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
    });
    // The body rides --input; the required --matter-id flag overlays
    // params.matterId (and overrides the stale id present in the JSON).
    await runCapabilityCommand({
      context: tty.context,
      flags: {
        input:
          '{"body":{"purpose":"agent_skill"},"params":{"matterId":"stale"}}',
        matterId: "ws-1",
      },
      spec,
    });
    server.stop();
    expect(tty.exitCode()).toBeUndefined();
    expect(lastInvoke(server.calls)["input"]).toEqual({
      body: { purpose: "agent_skill" },
      params: { matterId: "ws-1" },
    });
  });

  test("a required flag supplied only via --input's path is accepted", async () => {
    const server = startServer({ kind: "echo" });
    const spec = capSpec({
      capabilityId: "uploads.create",
      flags: [stringFlag("--matter-id", "params", "matterId", true)],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          params: {
            type: "object",
            additionalProperties: false,
            properties: { matterId: { type: "string" } },
          },
        },
      },
    });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
    });
    await runCapabilityCommand({
      context: tty.context,
      flags: { input: '{"params":{"matterId":"ws-9"}}' },
      spec,
    });
    server.stop();
    expect(tty.exitCode()).toBeUndefined();
    expect(lastInvoke(server.calls)["input"]).toEqual({
      params: { matterId: "ws-9" },
    });
  });

  test("a required schema path absent from --input but supplied by its flag is accepted (validation runs after overlay)", async () => {
    const server = startServer({ kind: "echo" });
    // A synthetic-required matterId plus a body-borne required field: the
    // exact shape (e.g. view-templates.delete) where validating the RAW --input
    // would reject params.matterId before --matter-id overlays it.
    const spec = capSpec({
      capabilityId: "view-templates.delete",
      flags: [stringFlag("--matter-id", "params", "matterId", true)],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          params: {
            type: "object",
            additionalProperties: false,
            required: ["matterId", "templateId"],
            properties: {
              matterId: { type: "string" },
              templateId: { type: "string" },
            },
          },
        },
      },
    });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
    });
    await runCapabilityCommand({
      context: tty.context,
      flags: { input: '{"params":{"templateId":"t1"}}', matterId: "ws-1" },
      spec,
    });
    server.stop();
    expect(tty.exitCode()).toBeUndefined();
    expect(lastInvoke(server.calls)["input"]).toEqual({
      params: { matterId: "ws-1", templateId: "t1" },
    });
  });

  test("a required flag absent from both flags and --input still errors (exit 2, no call)", async () => {
    const server = startServer({ kind: "echo" });
    const spec = capSpec({
      capabilityId: "uploads.create",
      flags: [stringFlag("--matter-id", "params", "matterId", true)],
    });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
    });
    await runCapabilityCommand({
      context: tty.context,
      flags: { input: '{"body":{"purpose":"agent_skill"}}' },
      spec,
    });
    server.stop();
    expect(tty.exitCode()).toBe(EXIT_CODES.validation);
    expect(server.calls).toHaveLength(0);
    expect(tty.stderrText()).toContain("--matter-id");
  });
});

describe("runCapabilityCommand: compound scope preflight", () => {
  test("rejects a document-only token before invoking a template capability", async () => {
    const server = startServer({ kind: "echo" });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
      token: makeToken(["documents_write"]),
    });
    await runCapabilityCommand({
      context: tty.context,
      flags: {},
      spec: capSpec({
        capabilityId: "templates.fills.create",
        scope: "documents_write",
        additionalScopes: ["templates"],
      }),
    });
    server.stop();
    expect(tty.exitCode()).toBe(EXIT_CODES.auth);
    expect(tty.stderrText()).toContain("stella:templates");
    expect(tty.stderrText()).toContain(
      "stella auth login --scopes stella:documents_write,stella:templates",
    );
    expect(server.calls).toHaveLength(0);
  });
});

describe("runCapabilityCommand: confirm gates", () => {
  test("reversible confirmation-required capabilities need fresh approval", async () => {
    const server = startServer({ kind: "echo" });
    const spec = capSpec({
      capabilityId: "memories.create",
      access: "write",
      destructive: false,
      confirmation: "required",
    });
    const denied = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
    });
    await runCapabilityCommand({ context: denied.context, flags: {}, spec });
    expect(denied.exitCode()).toBe(EXIT_CODES.aborted);
    expect(server.calls).toHaveLength(0);
    expect(denied.stderrText()).toContain("requiring approval");
    const allowed = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
    });
    await runCapabilityCommand({
      context: allowed.context,
      flags: { yes: true },
      spec,
    });
    expect(allowed.exitCode()).toBeUndefined();
    expect(lastInvoke(server.calls)["confirm"]).toBe(true);
    server.stop();
  });

  test("a read with --yes never sends confirmation arguments", async () => {
    const server = startServer({ kind: "echo" });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
    });
    await runCapabilityCommand({
      context: tty.context,
      flags: { yes: true },
      spec: capSpec({ capabilityId: "a.get", access: "read" }),
    });
    server.stop();
    expect(server.calls).toEqual([
      { name: "read_capability", args: { capability: "a.get", input: {} } },
    ]);
    expect(tty.exitCode()).toBeUndefined();
  });

  test("a read confirmation error is surfaced without prompting or retrying", async () => {
    const server = startServer({ kind: "confirm-gate" });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "y\n",
      isTTY: true,
    });
    await runCapabilityCommand({
      context: tty.context,
      flags: {},
      spec: capSpec({ capabilityId: "a.get", access: "read" }),
    });
    server.stop();
    expect(server.calls).toEqual([
      { name: "read_capability", args: { capability: "a.get", input: {} } },
    ]);
    expect(tty.exitCode()).toBe(EXIT_CODES.aborted);
    expect(tty.stderrText()).toContain("irreversible; retry with confirm");
    expect(tty.stderrText()).not.toContain("Confirm [y/N]");
  });

  test("a destructive capability off a TTY without --yes aborts (exit 7)", async () => {
    const server = startServer({ kind: "echo" });
    const spec = capSpec({
      capabilityId: "a.delete",
      access: "write",
      destructive: true,
    });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
    });
    await runCapabilityCommand({ context: tty.context, flags: {}, spec });
    server.stop();
    expect(tty.exitCode()).toBe(EXIT_CODES.aborted);
    expect(server.calls).toHaveLength(0);
  });

  test("--yes on a destructive capability sends confirm: true", async () => {
    const server = startServer({ kind: "echo" });
    const spec = capSpec({
      capabilityId: "a.delete",
      access: "write",
      destructive: true,
    });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
    });
    await runCapabilityCommand({
      context: tty.context,
      flags: { yes: true },
      spec,
    });
    server.stop();
    expect(lastInvoke(server.calls)["confirm"]).toBe(true);
  });

  test("confirmation_required prompt-and-retry on a TTY confirms and retries once", async () => {
    const server = startServer({ kind: "confirm-gate" });
    const spec = capSpec({ capabilityId: "a.risky", access: "write" });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "y\n",
      isTTY: true,
    });
    await runCapabilityCommand({ context: tty.context, flags: {}, spec });
    server.stop();
    expect(server.calls.map(({ name }) => name)).toEqual([
      "write_capability",
      "write_capability",
    ]);
    expect(server.calls[0]?.args["confirm"]).toBeUndefined();
    expect(server.calls[1]?.args["confirm"]).toBe(true);
    expect(tty.stdoutText()).toContain("done");
  });

  test("--no-input on a confirmation_required TTY fails closed (exit 7, --yes required)", async () => {
    const server = startServer({ kind: "confirm-gate" });
    const spec = capSpec({ capabilityId: "a.risky", access: "write" });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "y\n",
      isTTY: true,
    });
    await runCapabilityCommand({
      context: tty.context,
      flags: { noInput: true },
      spec,
    });
    server.stop();
    // Only the initial call; no retry (never prompted).
    expect(server.calls).toHaveLength(1);
    expect(tty.exitCode()).toBe(EXIT_CODES.aborted);
    expect(tty.stderrText()).toContain("--yes is required");
  });

  test("a declined confirm-retry prompt is terminal: exit 7, aborted line, no envelope", async () => {
    const server = startServer({ kind: "confirm-gate" });
    const spec = capSpec({ capabilityId: "a.risky", access: "write" });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "n\n",
      isTTY: true,
    });
    await runCapabilityCommand({ context: tty.context, flags: {}, spec });
    server.stop();
    expect(server.calls).toHaveLength(1);
    expect(tty.exitCode()).toBe(EXIT_CODES.aborted);
    expect(tty.stderrText()).toContain("aborted");
    // The original confirmation_required envelope is NOT rendered on top, and
    // no result reaches stdout (only the interactive prompt echo).
    expect(tty.stderrText()).not.toContain("error:");
    expect(tty.stdoutText()).not.toContain("done");
  });
});

describe("runCapabilityCommand: reserved flag values", () => {
  test("--limit abc is a usage error (exit 2), no server call", async () => {
    const server = startServer({ kind: "echo" });
    const spec = capSpec({
      capabilityId: "a.list",
      paginated: true,
      paginationPart: "query",
      itemsKey: "items",
    });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
    });
    await runCapabilityCommand({
      context: tty.context,
      flags: { limit: "abc" },
      spec,
    });
    server.stop();
    expect(server.calls).toHaveLength(0);
    expect(tty.exitCode()).toBe(EXIT_CODES.validation);
    expect(tty.stderrText()).toContain("--limit");
  });

  test("an unknown --output value is a usage error (exit 2), no server call", async () => {
    const server = startServer({ kind: "echo" });
    const spec = capSpec({ capabilityId: "a.b" });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
    });
    await runCapabilityCommand({
      context: tty.context,
      flags: { output: "yaml" },
      spec,
    });
    server.stop();
    expect(server.calls).toHaveLength(0);
    expect(tty.exitCode()).toBe(EXIT_CODES.validation);
    expect(tty.stderrText()).toContain("--output");
  });

  test("a valid --limit threads into the pagination part", async () => {
    const server = startServer({ kind: "echo" });
    const spec = capSpec({
      capabilityId: "a.list",
      paginated: true,
      paginationPart: "query",
      itemsKey: "items",
    });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
    });
    await runCapabilityCommand({
      context: tty.context,
      flags: { limit: "25" },
      spec,
    });
    server.stop();
    expect(lastInvoke(server.calls)["input"]).toEqual({
      query: { limit: 25 },
    });
  });
});

describe("runCapabilityCommand: output contract", () => {
  test("personal export commands dispatch every generated capability and preserve declared response shapes", async () => {
    const catalog = parseCapabilityCatalog(readCapabilityCatalog());
    if (catalog === null) {
      panic("Expected the committed capability catalog");
    }
    const exportId = "0199d851-071b-7000-8000-000000000001";
    const cases = [
      {
        capabilityId: "account-exports.create",
        flags: { output: "json" },
        output: {
          id: exportId,
          status: "requested",
          nextCall: {
            capability: "account-exports.status.get",
            input: { params: { exportId } },
          },
        },
      },
      {
        capabilityId: "account-exports.get",
        flags: { output: "json" },
        output: { latest: { id: exportId, status: "requested" } },
      },
      {
        capabilityId: "account-exports.status.get",
        flags: { exportId, output: "json" },
        output: { id: exportId, status: "requested" },
      },
      {
        capabilityId: "account-exports.download.get",
        flags: { exportId, output: "json" },
        output: {
          id: exportId,
          download: {
            downloadUrl: `https://api.example.test/v1/me/data-exports/${exportId}/download`,
            expiresAt: "2030-01-01T12:00:00Z",
          },
        },
      },
    ] as const;
    for (const item of cases) {
      const entry = catalog.find(({ id }) => id === item.capabilityId);
      if (entry === undefined) {
        panic(`Expected capability ${item.capabilityId}`);
      }
      const { spec } = deriveCapabilityLeaf(entry);
      expect(spec.commandPath).toEqual(capabilityCommandPath(entry.id));
      const server = startServer({ kind: "payload", payload: item.output });
      const tty = makeTtyContext({
        serverUrl: server.url,
        stdinData: "",
        isTTY: false,
        token: makeToken([
          "read",
          entry.access === "write"
            ? "account_export_write"
            : "account_export_read",
        ]),
      });
      await runCapabilityCommand({
        context: tty.context,
        flags: item.flags,
        spec,
      });
      expect(server.calls.at(-1)).toEqual({
        name: `${entry.access}_capability`,
        args: {
          capability: entry.id,
          input: "exportId" in item.flags ? { params: { exportId } } : {},
        },
      });
      expect(JSON.parse(tty.stdoutText())).toEqual(item.output);
      expect(tty.exitCode()).toBeUndefined();
      server.stop();
    }
  });

  test("personal export commands cannot choose another account and preserve ownership refusals", async () => {
    const catalog = parseCapabilityCatalog(readCapabilityCatalog());
    const entry = catalog?.find(
      ({ id }) => id === "account-exports.status.get",
    );
    if (entry === undefined) {
      panic("Expected the account export status capability");
    }
    const otherExportId = "0199d851-071b-7000-8000-000000000002";
    const refusal = {
      code: "not_found",
      message: "Export not found.",
      hint: "Call account-exports.get for your latest export ID or account-exports.create to request one.",
    };
    const server = startServer({ kind: "error", error: refusal });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
      token: makeToken(["read", "account_export_read"]),
    });
    await runCapabilityCommand({
      context: tty.context,
      flags: { exportId: otherExportId, output: "json" },
      spec: deriveCapabilityLeaf(entry).spec,
    });
    expect(server.calls).toEqual([
      {
        name: "read_capability",
        args: {
          capability: "account-exports.status.get",
          input: { params: { exportId: otherExportId } },
        },
      },
    ]);
    expect(tty.stderrText()).toContain(refusal.message);
    expect(tty.stderrText()).toContain(refusal.hint);
    expect(tty.exitCode()).toBe(EXIT_CODES.notFound);
    server.stop();
  });

  test("JSON output preserves full and partial case-law matches and their warning", async () => {
    const payload = {
      results: [
        { decisionId: "decision-1", match: "all_terms" },
        { decisionId: "decision-2", match: "some_terms" },
      ],
      searches: [{ warnings: [{ code: "partial_matches_appended" }] }],
      nextCursor: null,
    };
    const server = startServer({ kind: "pages", pages: [payload] });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
    });
    await runCapabilityCommand({
      context: tty.context,
      flags: { output: "json" },
      spec: capSpec({
        capabilityId: "case-law.decisions.search",
        itemsKey: "results",
      }),
    });
    server.stop();
    expect(tty.exitCode()).toBeUndefined();
    expect(JSON.parse(tty.stdoutText())).toEqual(payload);
  });

  test("typed country unavailability preserves its domain and recovery guidance in machine and human output", async () => {
    const unavailable = {
      code: "public_country_unavailable",
      status: "unavailable",
      domain: "legislation",
      country: "SVK",
      reason: "pending_public",
      message: "Legislation for this country is not publicly available yet.",
      hint: "Choose a country with public legislation search: CZE.",
    };
    for (const output of ["json", "jsonl", "table"] as const) {
      const server = startServer({ kind: "pages", pages: [unavailable] });
      const tty = makeTtyContext({
        serverUrl: server.url,
        stdinData: "",
        isTTY: output === "table",
      });
      await runCapabilityCommand({
        context: tty.context,
        flags: { output },
        spec: capSpec({ capabilityId: "legislation.search" }),
      });
      server.stop();
      if (output === "table") {
        expect(tty.stdoutText()).toContain("domain");
        expect(tty.stdoutText()).toContain(unavailable.domain);
        expect(tty.stdoutText()).toContain(unavailable.message);
        expect(tty.stdoutText()).toContain(unavailable.hint);
      } else {
        expect(JSON.parse(tty.stdoutText())).toEqual(unavailable);
      }
      expect(tty.stderrText()).toBe("");
      expect(tty.exitCode()).toBeUndefined();
    }
  });
  test("a page under `result` renders as a table with its resume cursor", async () => {
    const server = startServer({
      kind: "pages",
      pages: [
        { items: [{ name: "alpha" }, { name: "beta" }], nextCursor: "c1" },
      ],
    });
    const spec = capSpec({
      capabilityId: "a.list",
      paginated: true,
      paginationPart: "query",
      itemsKey: "items",
    });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
    });
    await runCapabilityCommand({
      context: tty.context,
      flags: { output: "table" },
      spec,
    });
    server.stop();
    const stdout = tty.stdoutText();
    expect(stdout).toContain("name");
    expect(stdout).toContain("alpha");
    expect(stdout).toContain("beta");
    expect(stdout).not.toContain("result");
    expect(tty.stderrText()).toBe("more: --cursor c1\n");
  });

  test("a page result under --output jsonl emits one item per line to stdout", async () => {
    const server = startServer({
      kind: "pages",
      pages: [{ items: [{ a: 1 }, { a: 2 }], nextCursor: null }],
    });
    const spec = capSpec({
      capabilityId: "a.list",
      paginated: true,
      paginationPart: "query",
      itemsKey: "items",
    });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
    });
    await runCapabilityCommand({
      context: tty.context,
      flags: { output: "jsonl" },
      spec,
    });
    server.stop();
    expect(tty.stdoutText()).toBe('{"a":1}\n{"a":2}\n');
  });

  test("--all --output jsonl streams items across pages and threads the cursor", async () => {
    const server = startServer({
      kind: "pages",
      pages: [
        { items: [{ a: 1 }], nextCursor: "c1" },
        { items: [{ a: 2 }], nextCursor: null },
      ],
    });
    const spec = capSpec({
      capabilityId: "a.list",
      paginated: true,
      paginationPart: "query",
      itemsKey: "items",
    });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
    });
    await runCapabilityCommand({
      context: tty.context,
      flags: { all: true, output: "jsonl" },
      spec,
    });
    server.stop();
    expect(tty.stdoutText()).toBe('{"a":1}\n{"a":2}\n');
    expect(server.calls.map(({ name }) => name)).toEqual([
      "read_capability",
      "read_capability",
    ]);
    // Second page threads the first page's cursor into input.query.cursor.
    const secondInput = server.calls[1]?.args["input"];
    expect(secondInput).toEqual({ query: { cursor: "c1" } });
  });

  test("results stay on stdout; the --all truncation notice goes to stderr", async () => {
    const server = startServer({
      kind: "pages",
      pages: [{ items: [{ a: 1 }], nextCursor: null }],
    });
    const spec = capSpec({
      capabilityId: "a.list",
      paginated: true,
      paginationPart: "query",
      itemsKey: "items",
    });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
    });
    await runCapabilityCommand({
      context: tty.context,
      flags: { all: true, output: "json" },
      spec,
    });
    server.stop();
    // A clean single page: JSON payload on stdout, nothing on stderr.
    expect(tty.stdoutText()).toContain('"items"');
    expect(tty.stderrText()).toBe("");
  });
});
