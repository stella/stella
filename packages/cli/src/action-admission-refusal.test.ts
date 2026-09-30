import { Result } from "better-result";
import { expect, test } from "bun:test";

import { respondToMcpLifecycle } from "../tests/mcp-test-lifecycle.js";
import {
  actionAdmissionRefusalLines,
  readActionAdmissionRefusal,
  readHttpActionAdmissionRefusal,
} from "./action-admission-refusal.js";
import { checkServerCompatibility } from "./compatibility.js";
import type { Context } from "./context.js";
import {
  ACTION_ADMISSION_REFUSALS,
  type ActionAdmissionCode,
} from "./generated/mcp-contract.js";
import {
  callTool,
  listResources,
  listTools,
  readResource,
} from "./mcp-client.js";
import { EXIT_CODES, resolveMcpErrorCodeExit } from "./mcp-constants.js";
import { refreshRegistryCache } from "./registry-refresh.js";
import {
  errorEnvelope,
  mapClientErrorExit,
  renderClientError,
  renderToolError,
  streamOrRenderAllPages,
} from "./run-leaf-command.js";
import { createUploadDocumentDependencies } from "./upload-document.js";

const EXPECTED_EXITS = {
  action_period_exhausted: EXIT_CODES.usageLimited,
  action_concurrency_busy: EXIT_CODES.server,
  action_not_enabled: EXIT_CODES.featureDisabled,
  action_admission_unavailable: EXIT_CODES.server,
} as const satisfies Record<ActionAdmissionCode, number>;

const render = async (
  run: (
    context: Context,
    writers: { stderr: (text: string) => void; stdout: (text: string) => void },
  ) => void | Promise<void>,
) => {
  let exit: NodeJS.Process["exitCode"];
  const fakeProcess = new Proxy(process, {
    get: (target, property) =>
      property === "exitCode" ? exit : Reflect.get(target, property),
    set: (_target, property, value) => {
      if (property !== "exitCode") {
        throw new TypeError(`Unexpected process mutation ${String(property)}`);
      }
      if (
        typeof value !== "number" &&
        typeof value !== "string" &&
        value !== undefined
      ) {
        throw new TypeError("Unexpected exit code");
      }
      exit = value;
      return true;
    },
  });
  const stderr: string[] = [];
  const stdout: string[] = [];
  await run(
    {
      process: fakeProcess,
      configDir: "/tmp/stella-refusal",
      serverUrl: undefined,
      token: undefined,
    },
    {
      stderr: (text) => stderr.push(text),
      stdout: (text) => stdout.push(text),
    },
  );
  return { stderr: stderr.join(""), stdout: stdout.join(""), exit };
};

for (const code of Object.keys(EXPECTED_EXITS)) {
  test(`admission parity ${code}: MCP tool, MCP HTTP, resources, direct HTTP and upload`, async () => {
    const metadata = readActionAdmissionRefusal({
      code,
      message: "Server message",
    });
    if (metadata === undefined) {
      throw new TypeError(`Missing admission fixture for ${code}`);
    }
    const refusal = {
      ...metadata,
      hint: "Server recovery guidance",
      contactUrl: "https://example.invalid/contact",
    };
    const contract = ACTION_ADMISSION_REFUSALS[refusal.code];
    const fixture = { ...refusal };
    const expected = `${actionAdmissionRefusalLines(refusal).join("\n")}\n`;
    const toolResult = {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: fixture }) }],
    };
    expect(errorEnvelope({ error: fixture })).toMatchObject(refusal);
    expect(readActionAdmissionRefusal({ error: fixture })).toEqual(refusal);
    expect(
      await readHttpActionAdmissionRefusal(Response.json(fixture)),
    ).toEqual(refusal);
    expect(
      await readHttpActionAdmissionRefusal(
        Response.json({
          code,
          message: fixture.message,
          hint: fixture.hint,
          contactUrl: fixture.contactUrl,
        }),
      ),
    ).toEqual(refusal);
    expect(resolveMcpErrorCodeExit(code)).toBe(EXPECTED_EXITS[refusal.code]);
    const tool = await render((context, writers) =>
      renderToolError({ context, writers, result: toolResult }),
    );
    expect(tool).toEqual({
      stderr: expected,
      stdout: "",
      exit: EXPECTED_EXITS[refusal.code],
    });
    const toolJson = await render((context, writers) =>
      renderToolError({ context, writers, result: toolResult, format: "json" }),
    );
    expect(JSON.parse(toolJson.stderr)).toEqual({ error: refusal });
    expect(toolJson.stdout).toBe("");

    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (request.method === "GET" || request.method === "PUT") {
          return Response.json(fixture, { status: contract.status });
        }
        const body: { id: number; method: string; params?: { name?: string } } =
          await request.json();
        const lifecycle = respondToMcpLifecycle(body);
        if (lifecycle !== null) {
          return lifecycle;
        }
        if (body.params?.name === "fixture-tool-error") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: toolResult,
          });
        }
        return Response.json(fixture, { status: contract.status });
      },
    });
    const options = { serverUrl: server.url.origin, token: "fixture-token" };
    try {
      const failures = await Promise.all([
        callTool({ ...options, name: "fixture", args: {} }),
        listTools(options),
        listResources(options),
        readResource({ ...options, uri: "fixture://reference" }),
      ]);
      for (const failure of failures) {
        expect(Result.isError(failure)).toBe(true);
        if (Result.isOk(failure)) {
          throw new TypeError("Expected admission failure");
        }
        expect(failure.error.admission).toEqual(refusal);
        expect(mapClientErrorExit(failure.error)).toBe(
          EXPECTED_EXITS[refusal.code],
        );
        expect(
          await render((context, writers) =>
            renderClientError({ context, writers, error: failure.error }),
          ),
        ).toEqual(tool);
        const httpJson = await render((context, writers) =>
          renderClientError({
            context,
            writers,
            error: failure.error,
            format: "json",
          }),
        );
        expect(httpJson).toEqual(toolJson);
        const refresh = await refreshRegistryCache({
          serverOrigin: options.serverUrl,
          token: options.token,
          env: { XDG_CACHE_HOME: `/tmp/stella-refusal-${Bun.randomUUIDv7()}` },
          force: true,
          fetchRaw: async () => Result.err(failure.error),
          fetchLatestVersion: async () => undefined,
        });
        expect(refresh).toEqual({ status: "admission-refused", refusal });
      }
      const pagination = await render(
        async (context, writers) =>
          await streamOrRenderAllPages({
            context,
            writers,
            format: "json",
            textPath: undefined,
            itemsKey: "items",
            baseArgs: {},
            serverUrl: options.serverUrl,
            token: options.token,
            toolName: "fixture-tool-error",
            cursorInto: (args) => args,
          }),
      );
      expect(pagination).toEqual(toolJson);
      const put = await createUploadDocumentDependencies(options).put({
        url: `${server.url.origin}/objects`,
        bytes: new Uint8Array([7]),
        headers: {},
      });
      expect(Result.isError(put)).toBe(true);
      if (Result.isError(put)) {
        expect(put.error).toEqual(refusal);
      }
      const compatibility = await checkServerCompatibility(server.url.origin);
      expect(Result.isError(compatibility)).toBe(true);
      if (Result.isError(compatibility)) {
        expect(compatibility.error.admission).toEqual(refusal);
      }
    } finally {
      server.stop(true);
    }
  });
}

test("admission parity leaves unrelated and malformed HTTP errors unchanged", async () => {
  for (const body of [
    null,
    "failure",
    { code: "not_found", message: "Gone" },
    { code: "action_period_exhausted" },
  ]) {
    expect(readActionAdmissionRefusal(body)).toBeUndefined();
  }
  expect(
    await readHttpActionAdmissionRefusal(new Response("invalid JSON")),
  ).toBeUndefined();
});
