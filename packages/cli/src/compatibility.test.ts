import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import packageJson from "../package.json" with { type: "json" };
import { CLI_REQUIRED_RESOURCE_SCOPES } from "./auth/constants.js";
import { checkServerCompatibility } from "./compatibility.js";
import {
  CLI_MINIMUM_SERVER_REVISION,
  CLI_REQUIRED_CAPABILITIES,
  CLI_SUPPORTED_API_PROTOCOLS,
} from "./generated/api-contract.js";

const CLI_ENTRYPOINT = path.join(import.meta.dirname, "cli.ts");
const tempDirs: string[] = [];
const hasOlderPositiveRevision = (minimumRevision: number): boolean =>
  minimumRevision > 1;

type CompatibilityOverrides = {
  readonly additionalContractFields?: Readonly<Record<string, unknown>>;
  readonly capabilities?: Readonly<Record<string, number>>;
  readonly contract?: boolean;
  readonly legacy?: boolean;
  readonly legacyApiContractVersion?: number;
  readonly maximum?: string;
  readonly minimum?: string;
  readonly protocol?: number;
  readonly revision?: number;
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
        ...(overrides.contract === false
          ? {}
          : {
              stella_contract: {
                ...overrides.additionalContractFields,
                protocol: overrides.protocol ?? CLI_SUPPORTED_API_PROTOCOLS[0],
                revision: overrides.revision ?? CLI_MINIMUM_SERVER_REVISION,
                capabilities:
                  overrides.capabilities ?? CLI_REQUIRED_CAPABILITIES,
              },
            }),
        ...(overrides.legacy === false
          ? {}
          : {
              stella_compatibility: {
                api_contract_version:
                  overrides.legacyApiContractVersion ??
                  CLI_SUPPORTED_API_PROTOCOLS[0],
                cli_version: {
                  maximum: overrides.maximum ?? packageJson.version,
                  minimum: overrides.minimum ?? packageJson.version,
                },
              },
            }),
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
  test("accepts the protocol, revision, capabilities, and required resource scopes", async () => {
    const server = startCompatibilityServer({
      // Proves the new contract takes precedence over the frozen legacy band.
      maximum: "0.0.1",
      minimum: "0.0.1",
    });
    try {
      const result = await checkServerCompatibility(server.url.origin);

      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        expect(result.value).toMatchObject({
          apiProtocolVersion: CLI_SUPPORTED_API_PROTOCOLS[0],
          compatibilitySource: "contract",
          serverRevision: CLI_MINIMUM_SERVER_REVISION,
          cliVersion: packageJson.version,
        });
      }
    } finally {
      await server.stop();
    }
  });

  test("accepts additive fields from a newer contract revision", async () => {
    const server = startCompatibilityServer({
      additionalContractFields: {
        future_addition: { description: "ignored by older CLIs" },
      },
      revision: CLI_MINIMUM_SERVER_REVISION + 1,
    });
    try {
      const result = await checkServerCompatibility(server.url.origin);

      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        expect(result.value).toMatchObject({
          compatibilitySource: "contract",
          serverRevision: CLI_MINIMUM_SERVER_REVISION + 1,
        });
      }
    } finally {
      await server.stop();
    }
  });

  test("falls back to the legacy package-version band for older servers", async () => {
    const server = startCompatibilityServer({ contract: false });
    try {
      const result = await checkServerCompatibility(server.url.origin);

      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        expect(result.value.compatibilitySource).toBe("legacy");
        expect(result.value).not.toHaveProperty("serverRevision");
      }
    } finally {
      await server.stop();
    }
  });

  test("rejects a server without either public compatibility contract", async () => {
    const server = startCompatibilityServer({ contract: false, legacy: false });
    try {
      const result = await checkServerCompatibility(server.url.origin);

      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.message).toContain(
          "does not advertise a stella compatibility contract",
        );
      }
    } finally {
      await server.stop();
    }
  });

  test("rejects an unsupported protocol", async () => {
    const unsupportedProtocol = startCompatibilityServer({ protocol: 999 });
    try {
      const protocolResult = await checkServerCompatibility(
        unsupportedProtocol.url.origin,
      );

      expect(Result.isError(protocolResult)).toBe(true);
      if (Result.isError(protocolResult)) {
        expect(protocolResult.error.message).toContain("API protocol 999");
      }
    } finally {
      await unsupportedProtocol.stop();
    }
  });

  test("rejects a non-positive server revision as malformed", async () => {
    const server = startCompatibilityServer({ revision: 0 });
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

  test.if(hasOlderPositiveRevision(CLI_MINIMUM_SERVER_REVISION))(
    "rejects a schema-valid revision below the CLI minimum",
    async () => {
      const server = startCompatibilityServer({
        revision: CLI_MINIMUM_SERVER_REVISION - 1,
      });
      try {
        const result = await checkServerCompatibility(server.url.origin);

        expect(Result.isError(result)).toBe(true);
        if (Result.isError(result)) {
          expect(result.error.message).toContain("is too old");
        }
      } finally {
        await server.stop();
      }
    },
  );

  test("rejects every missing required capability", async () => {
    const server = startCompatibilityServer({ capabilities: {} });
    try {
      const result = await checkServerCompatibility(server.url.origin);

      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        for (const [name, version] of Object.entries(
          CLI_REQUIRED_CAPABILITIES,
        )) {
          expect(result.error.message).toContain(`${name}>=${version}`);
        }
      }
    } finally {
      await server.stop();
    }
  });

  test("still rejects a CLI outside an older server's legacy range", async () => {
    const [major] = packageJson.version.split(".");
    const aboveCurrent = `${Number(major) + 1}.0.0`;
    const server = startCompatibilityServer({
      contract: false,
      maximum: `${Number(major) + 2}.0.0`,
      minimum: aboveCurrent,
    });
    try {
      const result = await checkServerCompatibility(server.url.origin);

      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.message).toContain(
          `CLI ${packageJson.version} is incompatible with this legacy server`,
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
      expect(stdout).toContain(
        `API protocol ${CLI_SUPPORTED_API_PROTOCOLS[0]}, server revision ${CLI_MINIMUM_SERVER_REVISION}`,
      );
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
