import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import packageJson from "../package.json" with { type: "json" };
import { CLI_REQUIRED_RESOURCE_SCOPES } from "./auth/constants.js";
import {
  checkCommandCompatibility,
  commandNeedsCompatibility,
} from "./command-compatibility.js";
import {
  CLI_REQUIRED_CAPABILITIES,
  CLI_SUPPORTED_API_PROTOCOLS,
} from "./generated/api-contract.js";

const metadata = (origin: string, protocol: number) => ({
  resource: `${origin}/mcp/advanced`,
  scopes_supported: CLI_REQUIRED_RESOURCE_SCOPES,
  stella_contract: {
    protocol,
    revision: 1,
    capabilities: CLI_REQUIRED_CAPABILITIES,
  },
  stella_compatibility: {
    api_contract_version: protocol,
    cli_version: { minimum: packageJson.version, maximum: packageJson.version },
  },
});

const commandFamilies = [
  ["auth", "whoami"],
  ["matter", "list"],
  ["matter", "save", "--input", '{"name":"example"}'],
  ["batch", "--input", "[]"],
  ["tools", "call", "save_contact"],
  ["tasks", "create", "--input", "{}"],
  ["upload", "--file", "example.txt"],
];

describe("compatibility admission before dispatch", () => {
  test("every remote family is gated while local recovery remains available", () => {
    for (const argv of commandFamilies) {
      expect(commandNeedsCompatibility(argv)).toBe(true);
    }
    for (const argv of [
      ["update"],
      ["doctor"],
      ["auth", "logout"],
      ["--help"],
    ]) {
      expect(commandNeedsCompatibility(argv)).toBe(false);
    }
  });

  for (const failure of [
    "newer protocol",
    "minimum version",
    "missing",
    "malformed",
  ] as const) {
    test(`${failure} refuses each command family before any API operation`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "stella-admission-"));
      let operations = 0;
      let discoveries = 0;
      const server = Bun.serve({
        port: 0,
        fetch(request) {
          const url = new URL(request.url);
          if (
            url.pathname ===
            "/.well-known/oauth-protected-resource/mcp/advanced"
          ) {
            discoveries += 1;
            if (failure === "missing") {
              return Response.json({});
            }
            if (failure === "malformed") {
              return new Response("not json");
            }
            const body = metadata(
              url.origin,
              Math.max(...CLI_SUPPORTED_API_PROTOCOLS) +
                (failure === "newer protocol" ? 1 : 0),
            );
            if (failure === "minimum version") {
              body.stella_compatibility.cli_version.minimum = "999.0.0";
            }
            return Response.json(body);
          }
          operations += 1;
          return new Response("unexpected API request", { status: 500 });
        },
      });
      try {
        for (const argv of commandFamilies) {
          const child = Bun.spawn(
            [
              process.execPath,
              path.join(import.meta.dirname, "cli.ts"),
              ...argv,
              "--server",
              server.url.origin,
            ],
            {
              env: {
                ...process.env,
                STELLA_API_KEY: "fixture",
                XDG_CONFIG_HOME: root,
                XDG_CACHE_HOME: root,
              },
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          const [code, stderr] = await Promise.all([
            child.exited,
            new Response(child.stderr).text(),
          ]);
          expect(code).toBe(2);
          expect(stderr).toContain("npm i -g @stll/cli@latest");
        }
        expect(discoveries).toBe(commandFamilies.length);
        expect(operations).toBe(0);
      } finally {
        await server.stop();
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  test("compatible metadata is reused only while fresh, and stale offline reads refuse", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stella-contract-cache-"));
    let discoveries = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        discoveries += 1;
        return Response.json(
          metadata(
            new URL(request.url).origin,
            Math.max(...CLI_SUPPORTED_API_PROTOCOLS),
          ),
        );
      },
    });
    const options = {
      serverUrl: server.url.origin,
      env: { XDG_CACHE_HOME: root },
      now: 1000,
    };
    try {
      expect(Result.isOk(await checkCommandCompatibility(options))).toBe(true);
      expect(Result.isOk(await checkCommandCompatibility(options))).toBe(true);
      expect(discoveries).toBe(1);
      await server.stop();
      expect(Result.isOk(await checkCommandCompatibility(options))).toBe(true);
      expect(
        Result.isError(
          await checkCommandCompatibility({
            ...options,
            now: 1000 + 86_400_000,
          }),
        ),
      ).toBe(true);
    } finally {
      await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
