import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { respondToMcpLifecycle } from "../tests/mcp-test-lifecycle.js";
import type { Context } from "./context.js";
import { EXIT_CODES } from "./mcp-constants.js";
import type { CapabilityFlagSpec, CapabilityLeafSpec } from "./route-types.js";
import { runCapabilityCommand } from "./run-capability-command.js";

type RecordedCall = { name: string; args: Record<string, unknown> };

type ServerResponse =
  | { kind: "echo" }
  | { kind: "confirm-gate" }
  | { kind: "receipt"; requestId: string }
  | { kind: "pages"; pages: readonly Record<string, unknown>[] };

/**
 * In-process MCP endpoint. `echo` returns the received args as the result so a
 * test can assert the exact `invoke_capability` payload; `confirm-gate` answers
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
      const text = (payload: unknown): Response =>
        Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: JSON.stringify(payload) }],
          },
        });
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
    url: `http://localhost:${server.port}`,
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
    // eslint-disable-next-line no-unsafe-type-assertion -- test double for the process slice
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

describe("runCapabilityCommand: flag -> invoke_capability payload", () => {
  test("routes flags into input parts and calls invoke_capability", async () => {
    const server = startServer({ kind: "echo" });
    const spec = capSpec({
      capabilityId: "billing-codes.create",
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
    expect(call?.name).toBe("invoke_capability");
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

  test("--input passes the whole input object through, validated", async () => {
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

  test("--input rejects an unknown field via the synthesized schema (exit 2)", async () => {
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
    expect(tty.exitCode()).toBe(EXIT_CODES.validation);
    expect(server.calls).toHaveLength(0);
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
        capabilityId: "templates.fill-to-matter",
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
  test("a destructive capability off a TTY without --yes aborts (exit 7)", async () => {
    const server = startServer({ kind: "echo" });
    const spec = capSpec({ capabilityId: "a.delete", destructive: true });
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
    const spec = capSpec({ capabilityId: "a.delete", destructive: true });
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
    const spec = capSpec({ capabilityId: "a.risky" });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "y\n",
      isTTY: true,
    });
    await runCapabilityCommand({ context: tty.context, flags: {}, spec });
    server.stop();
    expect(server.calls).toHaveLength(2);
    expect(server.calls[0]?.args["confirm"]).toBeUndefined();
    expect(server.calls[1]?.args["confirm"]).toBe(true);
    expect(tty.stdoutText()).toContain("done");
  });

  test("--no-input on a confirmation_required TTY fails closed (exit 7, --yes required)", async () => {
    const server = startServer({ kind: "confirm-gate" });
    const spec = capSpec({ capabilityId: "a.risky" });
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
    const spec = capSpec({ capabilityId: "a.risky" });
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

describe("runCapabilityCommand: request-id receipt", () => {
  const WRITE_ID = "req_ab12cd34ef567890ab12cd34ef567890";
  const READ_ID = "req_fedcba9876543210fedcba9876543210";
  // An untrusted server smuggling ANSI escape sequences into the receipt.
  const ANSI_ID = "req_\u001B]0;pwned\u0007\u001B[31mabcdef0123456789";

  test("a write surfaces the request id on stderr, not stdout", async () => {
    const server = startServer({ kind: "receipt", requestId: WRITE_ID });
    const spec = capSpec({ capabilityId: "a.create", access: "write" });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
    });
    await runCapabilityCommand({ context: tty.context, flags: {}, spec });
    server.stop();
    // The human-readable receipt line goes to stderr; stdout stays pure result
    // (which still carries the id inside the payload's meta, on its own).
    expect(tty.stderrText()).toContain(`request id: ${WRITE_ID}`);
    expect(tty.stdoutText()).not.toContain("request id:");
    expect(tty.exitCode()).toBeUndefined();
  });

  test("a read does not surface the request id", async () => {
    const server = startServer({ kind: "receipt", requestId: READ_ID });
    const spec = capSpec({ capabilityId: "a.get", access: "read" });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
    });
    await runCapabilityCommand({ context: tty.context, flags: {}, spec });
    server.stop();
    expect(tty.stderrText()).not.toContain("request id:");
  });

  test("an ANSI-laced receipt from the server is dropped, never rendered", async () => {
    const server = startServer({ kind: "receipt", requestId: ANSI_ID });
    const spec = capSpec({ capabilityId: "a.create", access: "write" });
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
    });
    await runCapabilityCommand({ context: tty.context, flags: {}, spec });
    server.stop();
    // The malformed id must not reach the terminal in any form: no receipt
    // line at all (drop, don't sanitize) and no escape byte on stderr.
    expect(tty.stderrText()).not.toContain("request id:");
    expect(tty.stderrText()).not.toContain("\u001B");
  });
});
