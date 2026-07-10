import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import type { Context } from "./context.js";
import { EXIT_CODES } from "./mcp-constants.js";
import type { FlagSpec, LeafCommandSpec } from "./route-types.js";
import {
  approvalReRunHint,
  buildArgsFromFlags,
  classifyToolError,
  flagKey,
  runLeafCommand,
} from "./run-leaf-command.js";

const specWith = (flags: readonly FlagSpec[]): LeafCommandSpec => ({
  commandPath: ["x", "y"],
  toolName: "x",
  flags,
  inputOnly: [],
  paginated: false,
  windowedText: false,
  destructive: false,
  inputSchema: { type: "object", properties: {} },
});

const stringFlag = (prop: string, required = false): FlagSpec => ({
  flag: `--${prop.replace(/_/gu, "-")}`,
  prop,
  kind: "string",
  required,
  repeatable: false,
});

describe("buildArgsFromFlags (S3)", () => {
  test("nullable-string literal `null` clears to JSON null", async () => {
    const spec = specWith([
      {
        flag: "--first-name",
        prop: "first_name",
        kind: "nullable-string",
        required: false,
        repeatable: false,
      },
    ]);
    const result = await buildArgsFromFlags(spec, {
      [flagKey({ prop: "first_name" })]: "null",
    });
    expect(result).toEqual({ ok: true, args: { first_name: null } });
  });

  test("nullable-string keeps a real string value", async () => {
    const spec = specWith([
      {
        flag: "--first-name",
        prop: "first_name",
        kind: "nullable-string",
        required: false,
        repeatable: false,
      },
    ]);
    const result = await buildArgsFromFlags(spec, { firstName: "Ada" });
    expect(result).toEqual({ ok: true, args: { first_name: "Ada" } });
  });

  test("enum rejects an out-of-set value", async () => {
    const spec = specWith([
      {
        flag: "--type",
        prop: "type",
        kind: "enum",
        enum: ["person", "org"],
        required: false,
        repeatable: false,
      },
    ]);
    const bad = await buildArgsFromFlags(spec, { type: "robot" });
    expect(bad.ok).toBe(false);
    const good = await buildArgsFromFlags(spec, { type: "person" });
    expect(good).toEqual({ ok: true, args: { type: "person" } });
  });

  test("int enforces min/max and accepts a negative parsed via `=`", async () => {
    const spec = specWith([
      {
        flag: "--padding",
        prop: "padding",
        kind: "int",
        min: 1,
        max: 6,
        required: false,
        repeatable: false,
      },
    ]);
    expect((await buildArgsFromFlags(spec, { padding: "9" })).ok).toBe(false);
    // A negative value is parsed (not rejected as non-int) then min-checked.
    const neg = await buildArgsFromFlags(spec, { padding: "-5" });
    expect(neg.ok).toBe(false);
    if (!neg.ok) {
      expect(neg.message).toContain(">= 1");
    }
    expect(await buildArgsFromFlags(spec, { padding: "3" })).toEqual({
      ok: true,
      args: { padding: 3 },
    });
  });

  test("repeatable arrays accumulate without comma-splitting", async () => {
    const spec = specWith([
      {
        flag: "--tag",
        prop: "tags",
        kind: "string-array",
        required: false,
        repeatable: true,
      },
    ]);
    const result = await buildArgsFromFlags(spec, { tags: ["a", "b"] });
    expect(result).toEqual({ ok: true, args: { tags: ["a", "b"] } });
  });

  test("a missing required flag is a usage error", async () => {
    const spec = specWith([stringFlag("matter_id", true)]);
    const result = await buildArgsFromFlags(spec, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("--matter-id");
    }
  });

  test("a leading literal @ is escaped as @@", async () => {
    const spec = specWith([stringFlag("name")]);
    const result = await buildArgsFromFlags(spec, { name: "@@handle" });
    expect(result).toEqual({ ok: true, args: { name: "@handle" } });
  });
});

describe("classifyToolError: structured envelope -> exit map (S4)", () => {
  const envelope = (code: string): unknown => ({
    error: { code, message: `msg for ${code}` },
  });

  test("every closed-set code maps to its distinct exit class", () => {
    expect(classifyToolError(envelope("validation_error"))).toBe(
      EXIT_CODES.validation,
    );
    expect(classifyToolError(envelope("missing_scope"))).toBe(EXIT_CODES.auth);
    expect(classifyToolError(envelope("feature_disabled"))).toBe(
      EXIT_CODES.featureDisabled,
    );
    expect(classifyToolError(envelope("not_found"))).toBe(EXIT_CODES.notFound);
    expect(classifyToolError(envelope("confirmation_required"))).toBe(
      EXIT_CODES.aborted,
    );
    expect(classifyToolError(envelope("permission_denied"))).toBe(
      EXIT_CODES.permissionDenied,
    );
    expect(classifyToolError(envelope("usage_limited"))).toBe(
      EXIT_CODES.usageLimited,
    );
    expect(classifyToolError(envelope("rate_limited"))).toBe(EXIT_CODES.server);
    expect(classifyToolError(envelope("unknown_tool"))).toBe(EXIT_CODES.server);
    expect(classifyToolError(envelope("internal_error"))).toBe(
      EXIT_CODES.server,
    );
  });

  test("an unknown envelope code falls to the server class", () => {
    expect(classifyToolError(envelope("some_new_code"))).toBe(
      EXIT_CODES.server,
    );
  });

  test("legacy bare `code` (no envelope) still upgrades feature_disabled to 5", () => {
    expect(
      classifyToolError({ code: "feature_disabled", message: "disabled" }),
    ).toBe(EXIT_CODES.featureDisabled);
    // Any other legacy bare code stays at the server class.
    expect(classifyToolError({ code: "not_found" })).toBe(EXIT_CODES.server);
  });

  test("a plain-text (non-record) error is the server class", () => {
    expect(classifyToolError("boom")).toBe(EXIT_CODES.server);
    expect(classifyToolError(undefined)).toBe(EXIT_CODES.server);
  });
});

describe("approvalReRunHint: two-phase handshake affordance", () => {
  const phaseOne = {
    channel: "email",
    status: "approval_required",
    confirmation_token: "tok-123",
  };

  test("returns the re-run hint on a TTY for an approval_required token", () => {
    expect(approvalReRunHint({ isTTY: true, payload: phaseOne })).toBe(
      "To approve after human review: re-run with --confirmation-token tok-123",
    );
  });

  test("is suppressed off a TTY (the token is already on stdout)", () => {
    expect(approvalReRunHint({ isTTY: false, payload: phaseOne })).toBeNull();
  });

  test("does not fire for a non-handshake or tokenless response", () => {
    expect(
      approvalReRunHint({ isTTY: true, payload: { status: "sent" } }),
    ).toBeNull();
    expect(
      approvalReRunHint({
        isTTY: true,
        payload: { status: "approval_required" },
      }),
    ).toBeNull();
  });
});

// --- confirm passthrough: prompt-and-retry on confirmation_required ----------

const CONFIRMATION_REQUIRED_BODY = {
  error: {
    code: "confirmation_required",
    message: "Capability x is irreversible and was called without confirmation",
    hint: "Confirm with the human user, then retry with confirm: true.",
  },
};

type RecordedCall = { name: string; args: Record<string, unknown> };

/**
 * In-process MCP endpoint: phase 1 (no `confirm`) answers the
 * `confirmation_required` envelope; a call carrying `confirm: true` succeeds.
 */
const startConfirmGateServer = () => {
  const calls: RecordedCall[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body: {
        params: { name: string; arguments?: Record<string, unknown> };
      } = JSON.parse(await req.text());
      const args = body.params.arguments ?? {};
      calls.push({ name: body.params.name, args });
      const confirmed = args["confirm"] === true;
      const result = confirmed
        ? {
            content: [{ type: "text", text: JSON.stringify({ done: true }) }],
          }
        : {
            content: [
              {
                type: "text",
                text: JSON.stringify(CONFIRMATION_REQUIRED_BODY),
              },
            ],
            isError: true,
          };
      return Response.json({ jsonrpc: "2.0", id: 1, result });
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

const INVOKE_SPEC: LeafCommandSpec = {
  commandPath: ["capability", "invoke"],
  toolName: "invoke_capability",
  flags: [
    {
      flag: "--capability",
      prop: "capability",
      kind: "string",
      required: true,
      repeatable: false,
    },
  ],
  inputOnly: ["input"],
  paginated: false,
  windowedText: false,
  destructive: false,
  confirmPassthrough: true,
  inputSchema: {
    type: "object",
    properties: {
      capability: { type: "string" },
      confirm: { type: "boolean" },
    },
    required: ["capability"],
  },
};

type FakeTty = {
  context: Context;
  exitCode: () => number | string | undefined;
  stderrText: () => string;
  stdoutText: () => string;
};

/** A Context whose stdin/stdout are in-process TTY-flagged streams. */
const makeTtyContext = ({
  serverUrl,
  stdinData,
  isTTY,
}: {
  serverUrl: string;
  stdinData: string;
  isTTY: boolean;
}): FakeTty => {
  const stdin = Object.assign(new PassThrough(), { isTTY });
  if (stdinData.length > 0) {
    stdin.write(stdinData);
  }
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdout = Object.assign(new PassThrough(), { isTTY });
  stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk.toString()));
  const stderr = Object.assign(new PassThrough(), { isTTY });
  stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString()));
  const proc = { stdin, stdout, stderr, exitCode: undefined, env: {} };
  const context: Context = {
    // SAFETY: runLeafCommand only reads stdin/stdout/stderr/exitCode off the
    // process; the PassThrough streams satisfy that structural slice.
    // eslint-disable-next-line no-unsafe-type-assertion -- test double for the process slice runLeafCommand reads
    process: proc as unknown as NodeJS.Process,
    configDir: "/tmp/stella-test",
    serverUrl,
    token: "header.payload.sig",
  };
  return {
    context,
    exitCode: () => proc.exitCode,
    stderrText: () => stderrChunks.join(""),
    stdoutText: () => stdoutChunks.join(""),
  };
};

describe("confirm passthrough (capability invoke)", () => {
  test("--yes injects confirm: true upfront (single call)", async () => {
    const server = startConfirmGateServer();
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
    });
    await runLeafCommand({
      context: tty.context,
      flags: { capability: "clauses.categories-delete", yes: true },
      spec: INVOKE_SPEC,
    });
    server.stop();
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]?.args["confirm"]).toBe(true);
    expect(tty.exitCode()).toBeUndefined();
    expect(tty.stdoutText()).toContain("done");
  });

  test("confirmation_required at a TTY prompts, then retries once with confirm", async () => {
    const server = startConfirmGateServer();
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "y\n",
      isTTY: true,
    });
    await runLeafCommand({
      context: tty.context,
      flags: { capability: "clauses.categories-delete" },
      spec: INVOKE_SPEC,
    });
    server.stop();
    expect(server.calls).toHaveLength(2);
    expect(server.calls[0]?.args["confirm"]).toBeUndefined();
    expect(server.calls[1]?.args["confirm"]).toBe(true);
    expect(tty.exitCode()).toBeUndefined();
    expect(tty.stdoutText()).toContain("done");
  });

  test("a declined prompt exits 7 without retrying", async () => {
    const server = startConfirmGateServer();
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "n\n",
      isTTY: true,
    });
    await runLeafCommand({
      context: tty.context,
      flags: { capability: "clauses.categories-delete" },
      spec: INVOKE_SPEC,
    });
    server.stop();
    expect(server.calls).toHaveLength(1);
    expect(tty.exitCode()).toBe(EXIT_CODES.aborted);
    expect(tty.stderrText()).toContain("error:");
  });

  test("non-TTY without --yes keeps today's behavior: exit 7, no prompt, no retry", async () => {
    const server = startConfirmGateServer();
    const tty = makeTtyContext({
      serverUrl: server.url,
      stdinData: "",
      isTTY: false,
    });
    await runLeafCommand({
      context: tty.context,
      flags: { capability: "clauses.categories-delete" },
      spec: INVOKE_SPEC,
    });
    server.stop();
    expect(server.calls).toHaveLength(1);
    expect(tty.exitCode()).toBe(EXIT_CODES.aborted);
  });
});
