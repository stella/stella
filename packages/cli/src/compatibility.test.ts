import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import packageJson from "../package.json" with { type: "json" };
import { CLI_REQUIRED_RESOURCE_SCOPES } from "./auth/constants.js";
import { checkServerCompatibility } from "./compatibility.js";

const CLI_ENTRYPOINT = path.join(import.meta.dirname, "cli.ts");
const tempDirs: string[] = [];

type CompatibilityOverrides = {
  readonly apiContractVersion?: number;
  readonly maximum?: string;
  readonly minimum?: string;
  readonly scopes?: readonly string[];
};

const startCompatibilityServer = (overrides: CompatibilityOverrides = {}) =>
  Bun.serve({
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/.well-known/oauth-protected-resource/mcp") {
        return new Response("Not found", { status: 404 });
      }
      return Response.json({
        authorization_servers: [`${url.origin}/api/auth`],
        bearer_methods_supported: ["header"],
        resource: `${url.origin}/mcp`,
        scopes_supported: overrides.scopes ?? CLI_REQUIRED_RESOURCE_SCOPES,
        stella_compatibility: {
          api_contract_version: overrides.apiContractVersion ?? 1,
          cli_version: {
            maximum: overrides.maximum ?? packageJson.version,
            minimum: overrides.minimum ?? packageJson.version,
          },
        },
      });
    },
    port: 0,
  });

const runCompatibilityCli = async (serverUrl: string) => {
  const configHome = await mkdtemp(path.join(tmpdir(), "stella-compat-"));
  tempDirs.push(configHome);
  const process = Bun.spawn({
    cmd: [
      "bun",
      CLI_ENTRYPOINT,
      "compatibility",
      "check",
      "--server",
      serverUrl,
    ],
    env: { ...globalThis.process.env, XDG_CONFIG_HOME: configHome },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { force: true, recursive: true });
    }),
  );
});

describe("deployed API compatibility", () => {
  test("accepts the inclusive current CLI range and required resource scopes", async () => {
    const server = startCompatibilityServer();
    try {
      const result = await checkServerCompatibility(server.url.origin);

      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        expect(result.value.apiContractVersion).toBe(1);
        expect(result.value.cliVersion).toBe(packageJson.version);
      }
    } finally {
      await server.stop();
    }
  });

  test("rejects a server without the public compatibility contract", async () => {
    const server = Bun.serve({
      fetch(request) {
        const url = new URL(request.url);
        return Response.json({
          resource: `${url.origin}/mcp`,
          scopes_supported: ["stella:read"],
        });
      },
      port: 0,
    });
    try {
      const result = await checkServerCompatibility(server.url.origin);

      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.message).toContain("absent or malformed");
      }
    } finally {
      await server.stop();
    }
  });

  test("rejects a CLI version outside the server's inclusive range", async () => {
    const server = startCompatibilityServer({
      maximum: "0.3.0",
      minimum: "0.2.1",
    });
    try {
      const result = await checkServerCompatibility(server.url.origin);

      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.message).toContain(
          `CLI ${packageJson.version} is incompatible`,
        );
      }
    } finally {
      await server.stop();
    }
  });

  test("rejects a server missing the packaged CLI resource scope surface", async () => {
    const server = startCompatibilityServer({ scopes: ["stella:search"] });
    try {
      const result = await checkServerCompatibility(server.url.origin);

      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.message).toContain("stella:read");
      }
    } finally {
      await server.stop();
    }
  });

  test("exposes an unauthenticated root command suitable for release canaries", async () => {
    const server = startCompatibilityServer();
    try {
      const { exitCode, stderr, stdout } = await runCompatibilityCli(
        server.url.origin,
      );

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain(`Compatible: CLI ${packageJson.version}`);
    } finally {
      await server.stop();
    }
  });

  test("the release-canary command exits nonzero for an incompatible API", async () => {
    const server = startCompatibilityServer({ scopes: ["stella:search"] });
    try {
      const { exitCode, stderr } = await runCompatibilityCli(server.url.origin);

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("stella:read");
    } finally {
      await server.stop();
    }
  });
});
