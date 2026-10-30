import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as v from "valibot";

import { respondToMcpLifecycle } from "../tests/mcp-test-lifecycle.js";
import { writeCredentialFile } from "./auth/credential-store.js";
import registry from "./generated/registry-snapshot.json";

// timeout: two CLI subprocesses each have a bounded 10-second startup deadline.
// Exercise the real shell twice: an in-memory cache cannot satisfy this test.
test("separate invocations reuse registry and token caches while tracing only durations", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "stella-startup-cache-"),
  );
  const configHome = path.join(directory, "config");
  const requests = { registry: 0, call: 0, unexpected: 0 };
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (request.method !== "POST") {
        return new Response(null, { status: 405 });
      }
      const body = v.parse(
        v.object({
          id: v.exactOptional(v.union([v.number(), v.string()])),
          method: v.exactOptional(v.string()),
        }),
        await request.json(),
      );
      const lifecycle = respondToMcpLifecycle(body);
      if (lifecycle !== null) {
        return lifecycle;
      }
      switch (body.method) {
        case "tools/list":
          requests.registry += 1;
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: { tools: registry },
          });
        case "tools/call":
          requests.call += 1;
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ matters: [], nextCursor: null }),
                },
              ],
            },
          });
        default:
          requests.unexpected += 1;
          return new Response(null, { status: 404 });
      }
    },
  });
  try {
    const now = Date.now();
    const secret = "synthetic-private-access-token";
    await writeCredentialFile(path.join(configHome, "stella"), {
      version: 1,
      defaultOrgByServer: { [server.url.origin]: "organization" },
      credentials: [
        {
          serverUrl: server.url.origin,
          orgId: "organization",
          clientId: "client",
          accessToken: secret,
          refreshToken: "synthetic-private-refresh-token",
          scope: "",
          tokenType: "Bearer",
          expiresAt: now + 3_600_000,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    const outputs: string[] = [];
    for (let invocation = 0; invocation < 2; invocation += 1) {
      const child = Bun.spawn(
        [
          process.execPath,
          new URL("cli.ts", import.meta.url).pathname,
          "matter",
          "list",
          "--json",
        ],
        {
          env: {
            ...process.env,
            STELLA_API_KEY: "",
            STELLA_SERVER_URL: server.url.origin,
            STELLA_TIMING: "1",
            XDG_CONFIG_HOME: configHome,
            XDG_CACHE_HOME: path.join(directory, "cache"),
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exitCode, stderr: exitCode === 0 ? "" : stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      outputs.push(stdout);
      expect(JSON.parse(stdout)).toEqual({ matters: [], nextCursor: null });
      const phases = [
        ...stderr.matchAll(/^stella timing (\S+) \d+\.\d+ms$/gmu),
      ].map((match) => match.at(1));
      expect(phases).toEqual([
        "process-start-to-main",
        "token-load-refresh",
        "registry-load-refresh",
        "api-call",
        "output",
      ]);
      expect(stderr).not.toContain(secret);
      expect(stderr).not.toContain("synthetic-private-refresh-token");
    }
    expect(outputs.at(0)).toBe(outputs.at(1));
    expect(requests).toEqual({ registry: 1, call: 2, unexpected: 0 });
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

// timeout: two independent CLI processes have bounded ten-second startup deadlines.
test.each([
  "missing-scope",
  "feature-disabled",
  "protocol-incompatible",
] as const)(
  "opaque callers report %s from authenticated registry evidence",
  async (cause) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "stella-scope-cache-"),
    );
    const configHome = path.join(directory, "config");
    let registryRequests = 0;
    let toolCalls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.method !== "POST") {
          return new Response(null, { status: 405 });
        }
        const body = v.parse(
          v.object({
            id: v.exactOptional(v.union([v.number(), v.string()])),
            method: v.exactOptional(v.string()),
          }),
          await request.json(),
        );
        const lifecycle = respondToMcpLifecycle(body);
        if (lifecycle !== null) {
          return lifecycle;
        }
        if (body.method === "tools/list") {
          registryRequests += 1;
          return Response.json(
            {
              jsonrpc: "2.0",
              id: body.id,
              result: {
                tools: registry.filter(
                  (tool) =>
                    tool.name !==
                    (cause === "missing-scope"
                      ? "list_matters"
                      : "list_time_entries"),
                ),
                ...(cause === "feature-disabled"
                  ? {
                      _meta: {
                        featureAccess: {
                          tools: [],
                          capabilities: [],
                          disabled: {
                            tools: ["list_time_entries"],
                            capabilities: [],
                          },
                        },
                      },
                    }
                  : {}),
              },
            },
            {
              headers: {
                "x-stella-api-contract-version":
                  cause === "protocol-incompatible" ? "999" : "3",
                "x-stella-scopes":
                  cause === "missing-scope"
                    ? "openid stella:search"
                    : "openid stella:read",
                ...(cause === "missing-scope"
                  ? { "x-stella-scope-omitted-tools": "list_matters" }
                  : {}),
              },
            },
          );
        }
        toolCalls += 1;
        return new Response(null, { status: 500 });
      },
    });
    try {
      const now = Date.now();
      await writeCredentialFile(path.join(configHome, "stella"), {
        version: 1,
        defaultOrgByServer: { [server.url.origin]: "organization" },
        credentials: [
          {
            serverUrl: server.url.origin,
            orgId: "organization",
            clientId: "client",
            accessToken: "opaque-private-token",
            scope: "stella:read",
            tokenType: "Bearer",
            expiresAt: now + 3_600_000,
            createdAt: now,
            updatedAt: now,
          },
        ],
      });
      for (
        let invocation = 0;
        invocation < (cause === "protocol-incompatible" ? 1 : 2);
        invocation += 1
      ) {
        const child = Bun.spawn(
          [
            process.execPath,
            new URL("cli.ts", import.meta.url).pathname,
            cause === "feature-disabled" ? "time-entry" : "matter",
            "list",
            "--json",
          ],
          {
            env: {
              ...process.env,
              STELLA_API_KEY: "",
              STELLA_SERVER_URL: server.url.origin,
              XDG_CONFIG_HOME: configHome,
              XDG_CACHE_HOME: path.join(directory, "cache"),
            },
            stdout: "pipe",
            stderr: "pipe",
            timeout: 10_000,
          },
        );
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        const exitCodes = {
          "missing-scope": 3,
          "feature-disabled": 5,
          "protocol-incompatible": 4,
        };
        expect({ exitCode, stdout }).toEqual({
          exitCode: exitCodes[cause],
          stdout: "",
        });
        switch (cause) {
          case "missing-scope":
            expect(stderr).toContain("Missing scope stella:read.");
            expect(stderr).toContain(
              `stella auth login --scopes stella:search,stella:read --server ${server.url.origin}`,
            );
            expect(stderr).not.toContain("not enabled for this organization");
            break;
          case "feature-disabled":
            expect(stderr).toContain(
              "Command 'time-entry list' is not enabled for this organization (feature: time-billing).",
            );
            expect(stderr).not.toContain("Missing scope");
            expect(stderr).not.toContain("stella auth login");
            break;
          case "protocol-incompatible":
            expect(stderr).toContain(
              "Server API protocol 999 is incompatible; this CLI supports 3.",
            );
            expect(stderr).not.toContain("Missing scope");
            expect(stderr).not.toContain("not enabled for this organization");
            expect(stderr).not.toContain("stella auth login");
            break;
          default:
            cause satisfies never;
        }
        expect(stderr).not.toContain("unknown to this server");
        if (cause !== "protocol-incompatible") {
          expect(stderr).not.toContain("protocol is incompatible");
        }
        expect(stderr).not.toContain("opaque-private-token");
      }
      expect(registryRequests).toBe(1);
      expect(toolCalls).toBe(0);
    } finally {
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
