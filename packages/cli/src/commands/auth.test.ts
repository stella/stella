import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { respondToMcpLifecycle } from "../../tests/mcp-test-lifecycle.js";
import type { Context } from "../context.js";
import { describeExpiry, runWhoami } from "./auth.js";

// Guards the "identity command whose --help promises a server-verified result
// but does no server call" class. `stella auth whoami` under STELLA_API_KEY used
// to echo three static lines and exit 0 whether the key was valid or not, so an
// agent could not confirm auth. These tests assert whoami now makes a REAL
// authenticated round-trip: it reports the server-resolved org + scopes on a
// valid key, and FAILS clearly (no static exit-0 echo) on a rejected key.

type FakeProcess = {
  process: Context["process"];
  stdout: () => string;
};

const fakeProcess = (): FakeProcess => {
  const chunks: string[] = [];
  const proc = {
    stdout: {
      write: (text: string) => {
        chunks.push(text);
        return true;
      },
    },
  };
  return {
    // SAFETY: runWhoami only writes to process.stdout; this covers that slice.
    // eslint-disable-next-line no-unsafe-type-assertion -- test double for the process slice
    process: proc as unknown as Context["process"],
    stdout: () => chunks.join(""),
  };
};

type IdentityServer = {
  url: string;
  requests: () => number;
  stop: () => void;
};

const startIdentityServer = ({
  status,
  organizationId,
  scopes,
}: {
  status: number;
  organizationId?: string;
  scopes?: string;
}): IdentityServer => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests += 1;
      if (status !== 200) {
        return new Response("nope", { status });
      }
      if (request.method === "GET") {
        return new Response(null, { status: 405 });
      }
      const body: { method?: string } = JSON.parse(await request.text());
      const lifecycle = respondToMcpLifecycle(body);
      if (lifecycle !== null) {
        return lifecycle;
      }
      const headers = new Headers({ "Content-Type": "application/json" });
      if (organizationId !== undefined) {
        headers.set("x-stella-organization", organizationId);
      }
      if (scopes !== undefined) {
        headers.set("x-stella-scopes", scopes);
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
        { headers },
      );
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    requests: () => requests,
    stop: () => {
      void server.stop(true);
    },
  };
};

describe("runWhoami with a machine API key", () => {
  test("reports the server-resolved org and scopes on a valid key", async () => {
    const server = startIdentityServer({
      status: 200,
      organizationId: "org_live",
      scopes: "stella:read stella:matters_write",
    });
    const fake = fakeProcess();
    const result = await runWhoami({
      process: fake.process,
      configDir: "/tmp/stella-whoami-test",
      orgFlag: undefined,
      serverFlag: server.url,
      apiKey: "stella_mk_valid",
    });
    server.stop();

    expect(result).toBeUndefined();
    // A real round-trip happened (a static echo would make zero requests).
    expect(server.requests()).toBeGreaterThan(0);
    const out = fake.stdout();
    expect(out).toContain("org_live");
    expect(out).toContain("stella:read stella:matters_write");
    expect(out).toContain("machine API key");
  });

  test("fails clearly on a rejected key instead of a static exit-0 echo", async () => {
    const server = startIdentityServer({ status: 401 });
    const fake = fakeProcess();
    const result = await runWhoami({
      process: fake.process,
      configDir: "/tmp/stella-whoami-test",
      orgFlag: undefined,
      serverFlag: server.url,
      apiKey: "stella_mk_revoked",
    });
    server.stop();

    // The key was actually sent to the server (round-trip), and the rejection
    // surfaces as an error, not a success echo.
    expect(server.requests()).toBeGreaterThan(0);
    expect(result).toBeInstanceOf(Error);
    if (result instanceof Error) {
      expect(result.message).toContain("rejected");
    }
    // No success identity was printed.
    expect(fake.stdout()).not.toContain("Organization:");
  });
});

// whoami used to print opaque ids only, because the access token carries no
// email or name. Login now stores both off the `id_token`.
describe("runWhoami with a stored credential", () => {
  const writeCredential = async (
    configDir: string,
    credential: Record<string, unknown>,
  ): Promise<void> => {
    await mkdir(configDir, { recursive: true });
    await Bun.write(
      path.join(configDir, "credentials.json"),
      JSON.stringify({
        version: 1,
        defaultOrgByServer: { "https://api.example.test": "org_1" },
        credentials: [credential],
      }),
    );
  };

  const storedCredential = (
    identity: Record<string, unknown>,
  ): Record<string, unknown> => ({
    serverUrl: "https://api.example.test",
    orgId: "org_1",
    clientId: "client_1",
    accessToken: "opaque-token",
    scope: "stella:read",
    tokenType: "Bearer",
    expiresAt: Date.now() + 900_000,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...identity,
  });

  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(os.tmpdir(), "stella-cli-whoami-"));
  });

  afterEach(async () => {
    await rm(configDir, { force: true, recursive: true });
  });

  test("prints the account email and name when the credential carries them", async () => {
    await writeCredential(
      configDir,
      storedCredential({ email: "person@example.com", name: "A Person" }),
    );
    const fake = fakeProcess();

    const result = await runWhoami({
      process: fake.process,
      configDir,
      orgFlag: undefined,
      serverFlag: "https://api.example.test",
      apiKey: undefined,
    });

    expect(result).toBeUndefined();
    expect(fake.stdout()).toContain("Account: person@example.com (A Person)");
  });

  test("omits the account line for a credential written without identity claims", async () => {
    await writeCredential(configDir, storedCredential({}));
    const fake = fakeProcess();

    const result = await runWhoami({
      process: fake.process,
      configDir,
      orgFlag: undefined,
      serverFlag: "https://api.example.test",
      apiKey: undefined,
    });

    expect(result).toBeUndefined();
    expect(fake.stdout()).not.toContain("Account:");
    expect(fake.stdout()).toContain("Organization: org_1");
  });
});

describe("describeExpiry", () => {
  const now = Date.UTC(2026, 8, 5, 9, 0, 0);

  test("reads as minutes, hours, days, or expired", () => {
    expect(describeExpiry(now + 12 * 60_000, now)).toBe("in 12 min");
    expect(describeExpiry(now + 3 * 3_600_000, now)).toBe("in 3 h");
    expect(describeExpiry(now + 2 * 86_400_000, now)).toBe("in 2 d");
    expect(describeExpiry(now - 1, now)).toBe("expired");
  });
});
