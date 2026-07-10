// End-to-end command tests (spec 051 S6): each MVP command is driven through the
// real stricli-built CLI (`bun cli.ts ...`) against an in-process mock MCP
// endpoint. `Bun.spawn` (async) is used, not `spawnSync`, so the in-process
// `Bun.serve` can answer requests concurrently. No real network origin is hit.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI_ENTRYPOINT = path.join(import.meta.dirname, "cli.ts");

const base64url = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** A JWT-shaped access token carrying the given granted scopes. */
const makeToken = (scopes: readonly string[]): string => {
  const header = base64url({ alg: "none", typ: "JWT" });
  const payload = base64url({
    sub: "user-1",
    exp: Math.floor(Date.now() / 1000) + 3600,
    scope: scopes.map((s) => `stella:${s}`).join(" "),
  });
  return `${header}.${payload}.sig`;
};

type JsonRpcRequest = {
  method: string;
  params: { name?: string; arguments?: Record<string, unknown>; uri?: string };
};

type MockResponse =
  | { httpStatus: number; body?: string }
  | { toolPayload: unknown; isError?: boolean }
  | { rpcResult: unknown }
  | { rpc: { code: number; message: string } };

type MockHandler = (request: JsonRpcRequest, callIndex: number) => MockResponse;

const startMockServer = (handler: MockHandler) => {
  const requests: JsonRpcRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body: JsonRpcRequest = JSON.parse(await req.text());
      const index = requests.length;
      requests.push(body);
      const response = handler(body, index);
      if ("httpStatus" in response) {
        return new Response(response.body ?? "error", {
          status: response.httpStatus,
        });
      }
      if ("rpc" in response) {
        return Response.json({ jsonrpc: "2.0", id: 1, error: response.rpc });
      }
      if ("rpcResult" in response) {
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: response.rpcResult,
        });
      }
      const result: {
        content: { type: "text"; text: string }[];
        isError?: true;
      } = {
        content: [{ type: "text", text: JSON.stringify(response.toolPayload) }],
      };
      if (response.isError) {
        result.isError = true;
      }
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result,
      });
    },
  });
  return {
    requests,
    url: `http://localhost:${server.port}`,
    stop: () => {
      void server.stop(true);
    },
  };
};

const tempDirs: string[] = [];

const writeCredentials = async ({
  configHome,
  url,
  token,
}: {
  configHome: string;
  url: string;
  token: string;
}): Promise<void> => {
  const dir = path.join(configHome, "stella");
  await mkdir(dir, { recursive: true });
  const now = Date.now();
  const file = {
    version: 1,
    defaultOrgByServer: { [url]: "org-1" },
    credentials: [
      {
        serverUrl: url,
        orgId: "org-1",
        clientId: "client-1",
        accessToken: token,
        scope: "stella:read",
        tokenType: "Bearer",
        expiresAt: now + 3_600_000,
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
  await writeFile(path.join(dir, "credentials.json"), JSON.stringify(file));
};

type RunResult = { exitCode: number; stdout: string; stderr: string };

const runCli = async ({
  args,
  url,
  token,
  stdin,
  signedIn = true,
}: {
  args: readonly string[];
  url: string;
  token: string;
  stdin?: string;
  signedIn?: boolean;
}): Promise<RunResult> => {
  const configHome = await mkdtemp(path.join(tmpdir(), "stella-cli-"));
  tempDirs.push(configHome);
  if (signedIn) {
    await writeCredentials({ configHome, url, token });
  }

  const proc = Bun.spawn({
    cmd: ["bun", CLI_ENTRYPOINT, ...args],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
      STELLA_SERVER_URL: url,
    },
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (stdin !== undefined && proc.stdin !== undefined) {
    void proc.stdin.write(stdin);
    await proc.stdin.end();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    }),
  );
});

const READ = makeToken(["read"]);
const WRITE = makeToken(["read", "matters_write"]);

describe("auth and scope gating (S4)", () => {
  test("no stored credential exits 3", async () => {
    const server = startMockServer(() => ({ toolPayload: {} }));
    const result = await runCli({
      args: ["matter", "list"],
      url: server.url,
      token: READ,
      signedIn: false,
    });
    server.stop();
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("Not signed in");
    expect(server.requests).toHaveLength(0);
  });

  test("a scope not granted exits 3 with no server call", async () => {
    const server = startMockServer(() => ({ toolPayload: {} }));
    const result = await runCli({
      args: ["matter", "save", "--name", "X"],
      url: server.url,
      token: makeToken(["read"]), // lacks matters_write
    });
    server.stop();
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("stella:matters_write");
    expect(server.requests).toHaveLength(0);
  });
});

describe("list rendering and pagination (S4)", () => {
  test("matter list renders a table and hints the next cursor on stderr", async () => {
    const server = startMockServer(() => ({
      toolPayload: {
        matters: [
          { id: "m1", name: "Acme", reference: "R1", status: "active" },
        ],
        nextCursor: "cur-2",
      },
    }));
    const result = await runCli({
      args: ["matter", "list", "--table"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("m1");
    expect(result.stdout).toContain("Acme");
    expect(result.stderr).toContain("more: --cursor cur-2");
    expect(server.requests.at(0)?.params.name).toBe("list_matters");
  });

  test("matter list defaults to JSON off a TTY", async () => {
    const server = startMockServer(() => ({
      toolPayload: { matters: [{ id: "m1" }], nextCursor: null },
    }));
    const result = await runCli({
      args: ["matter", "list"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      matters: [{ id: "m1" }],
      nextCursor: null,
    });
  });

  test("--all follows cursors and merges pages", async () => {
    const server = startMockServer((_req, index) =>
      index === 0
        ? { toolPayload: { matters: [{ id: "m1" }], nextCursor: "c1" } }
        : { toolPayload: { matters: [{ id: "m2" }], nextCursor: null } },
    );
    const result = await runCli({
      args: ["matter", "list", "--all", "--json"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).matters).toEqual([
      { id: "m1" },
      { id: "m2" },
    ]);
    expect(server.requests).toHaveLength(2);
    expect(server.requests.at(1)?.params.arguments?.["cursor"]).toBe("c1");
  });

  test("--all stops at the page ceiling and prints a resume line, exit 0", async () => {
    const server = startMockServer(() => ({
      toolPayload: { matters: [{ id: "m" }], nextCursor: "always" },
    }));
    const result = await runCli({
      args: ["matter", "list", "--all", "--json"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("--all truncated");
    expect(server.requests).toHaveLength(50);
  });

  test("single-read flip renders a single object, not a table", async () => {
    const server = startMockServer(() => ({
      toolPayload: {
        matter: { id: "m1", name: "Acme" },
        overview: {},
        contacts: [],
        members: [],
      },
    }));
    const result = await runCli({
      args: ["matter", "list", "--matter-id", "m1", "--json"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).matter).toEqual({
      id: "m1",
      name: "Acme",
    });
    expect(server.requests.at(0)?.params.arguments).toEqual({
      matter_id: "m1",
    });
  });
});

describe("windowed text (S4)", () => {
  test("search read prints raw document text", async () => {
    const server = startMockServer(() => ({
      toolPayload: { name: "Doc", text: "THE FULL BODY", nextCursor: null },
    }));
    const result = await runCli({
      args: ["search", "read", "--entity-id", "e1"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("THE FULL BODY");
  });
});

describe("value flags and validation (S3)", () => {
  test("missing required flag exits 2 with no server call", async () => {
    const server = startMockServer(() => ({ toolPayload: {} }));
    const result = await runCli({
      args: ["matter", "delete"],
      url: server.url,
      token: WRITE,
    });
    server.stop();
    expect(result.exitCode).toBe(2);
    expect(server.requests).toHaveLength(0);
  });

  test("an out-of-enum value exits 2 client-side", async () => {
    const server = startMockServer(() => ({ toolPayload: {} }));
    const result = await runCli({
      args: [
        "contact",
        "lookup-registry",
        "--registry",
        "not-a-registry",
        "--query",
        "Acme",
      ],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(2);
    expect(server.requests).toHaveLength(0);
  });

  test("nullable-string `null` is sent as JSON null", async () => {
    const server = startMockServer(() => ({
      toolPayload: { contactId: "c1" },
    }));
    const result = await runCli({
      args: ["contact", "save", "--contact-id", "c1", "--first-name", "null"],
      url: server.url,
      token: WRITE,
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(server.requests.at(0)?.params.arguments).toEqual({
      contact_id: "c1",
      first_name: null,
    });
  });
});

describe("--input escape hatch (S3)", () => {
  test("--input '<json>' supplies the whole args object", async () => {
    const server = startMockServer(() => ({ toolPayload: { matterId: "m9" } }));
    const result = await runCli({
      args: ["matter", "save", "--input", '{"name":"New Matter"}'],
      url: server.url,
      token: WRITE,
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(server.requests.at(0)?.params.arguments).toEqual({
      name: "New Matter",
    });
  });

  test("--input - reads the object from stdin", async () => {
    const server = startMockServer(() => ({ toolPayload: { matterId: "m9" } }));
    const result = await runCli({
      args: ["matter", "save", "--input", "-"],
      url: server.url,
      token: WRITE,
      stdin: '{"name":"From Stdin"}',
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(server.requests.at(0)?.params.arguments).toEqual({
      name: "From Stdin",
    });
  });

  test("--input @file reads the object from a file", async () => {
    const server = startMockServer(() => ({ toolPayload: { matterId: "m9" } }));
    const file = path.join(
      await mkdtemp(path.join(tmpdir(), "stella-in-")),
      "in.json",
    );
    await writeFile(file, '{"name":"From File"}');
    const result = await runCli({
      args: ["matter", "save", "--input", `@${file}`],
      url: server.url,
      token: WRITE,
    });
    server.stop();
    await rm(path.dirname(file), { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(server.requests.at(0)?.params.arguments).toEqual({
      name: "From File",
    });
  });

  test("--input with a value flag conflicts, exit 2", async () => {
    const server = startMockServer(() => ({ toolPayload: {} }));
    const result = await runCli({
      args: ["matter", "save", "--input", "{}", "--name", "X"],
      url: server.url,
      token: WRITE,
    });
    server.stop();
    expect(result.exitCode).toBe(2);
    expect(server.requests).toHaveLength(0);
  });

  test("--input failing schema validation exits 2", async () => {
    const server = startMockServer(() => ({ toolPayload: {} }));
    const result = await runCli({
      args: ["matter", "save", "--input", '{"status":"bogus"}'],
      url: server.url,
      token: WRITE,
    });
    server.stop();
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--input invalid");
    expect(server.requests).toHaveLength(0);
  });
});

describe("destructive confirmation (S4)", () => {
  test("--yes skips the prompt and proceeds", async () => {
    const server = startMockServer(() => ({ toolPayload: { deleted: true } }));
    const result = await runCli({
      args: ["matter", "delete", "--matter-id", "m1", "--yes"],
      url: server.url,
      token: WRITE,
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(server.requests).toHaveLength(1);
  });

  test("non-TTY without --yes aborts with exit 7 and no server call", async () => {
    const server = startMockServer(() => ({ toolPayload: { deleted: true } }));
    const result = await runCli({
      args: ["matter", "delete", "--matter-id", "m1"],
      url: server.url,
      token: WRITE,
    });
    server.stop();
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("refusing destructive op");
    expect(server.requests).toHaveLength(0);
  });
});

describe("error tiers -> exit codes (S4)", () => {
  test("HTTP 500 -> exit 4", async () => {
    const server = startMockServer(() => ({ httpStatus: 500 }));
    const result = await runCli({
      args: ["matter", "list"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(4);
  });

  test("HTTP 404 -> exit 6", async () => {
    const server = startMockServer(() => ({ httpStatus: 404 }));
    const result = await runCli({
      args: ["matter", "list"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(6);
  });

  test("HTTP 401 -> exit 3", async () => {
    const server = startMockServer(() => ({ httpStatus: 401 }));
    const result = await runCli({
      args: ["matter", "list"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(3);
  });

  test("MCP InvalidParams (-32602) -> exit 2", async () => {
    const server = startMockServer(() => ({
      rpc: { code: -32_602, message: "invalid params" },
    }));
    const result = await runCli({
      args: ["matter", "list"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(2);
  });

  test("a tool isError result -> exit 4 with the message verbatim on stderr", async () => {
    const server = startMockServer(() => ({
      toolPayload: "Insufficient permissions. Required scope: stella:read",
      isError: true,
    }));
    const result = await runCli({
      args: ["matter", "list"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("Insufficient permissions");
  });

  test("a validation_error envelope renders issues on stderr and exits 2", async () => {
    const server = startMockServer(() => ({
      toolPayload: {
        error: {
          code: "validation_error",
          message: "Invalid input",
          issues: [
            { path: "matter_id", message: "Required" },
            { path: "", message: "at least one filter is required" },
          ],
        },
      },
      isError: true,
    }));
    const result = await runCli({
      args: ["matter", "list"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("error: Invalid input");
    // A field issue renders as `  <path>: <message>`; a root issue (empty path)
    // renders its message without a bare `: ` prefix.
    expect(result.stderr).toContain("  matter_id: Required");
    expect(result.stderr).toContain("  at least one filter is required");
  });
});

describe("help surfaces --input for inputOnly tools", () => {
  test("template save --help documents the --input-only fields", async () => {
    const server = startMockServer(() => ({ toolPayload: {} }));
    const result = await runCli({
      args: ["template", "save", "--help"],
      url: server.url,
      token: makeToken(["templates"]),
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--input");
    expect(result.stdout).toContain("fields");
  });

  test("clause save --help documents both --input-only fields", async () => {
    const server = startMockServer(() => ({ toolPayload: {} }));
    const result = await runCli({
      args: ["clause", "save", "--help"],
      url: server.url,
      token: makeToken(["knowledge_write"]),
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--input");
    expect(result.stdout).toContain("body");
    expect(result.stdout).toContain("metadata");
  });
});

describe("organization discriminator split (S2/Phase 4)", () => {
  test("add-member injects action and forwards the flag args", async () => {
    const server = startMockServer(() => ({ toolPayload: { ok: true } }));
    const result = await runCli({
      args: [
        "organization",
        "add-member",
        "--matter-id",
        "m1",
        "--user-id",
        "u1",
      ],
      url: server.url,
      token: makeToken(["admin_write"]),
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(server.requests.at(0)?.params.name).toBe("manage_organization");
    expect(server.requests.at(0)?.params.arguments).toEqual({
      action: "add_member",
      matter_id: "m1",
      user_id: "u1",
    });
  });

  test("remove-member is destructive: non-TTY without --yes aborts (exit 7)", async () => {
    const server = startMockServer(() => ({ toolPayload: { ok: true } }));
    const result = await runCli({
      args: [
        "organization",
        "remove-member",
        "--matter-id",
        "m1",
        "--user-id",
        "u1",
      ],
      url: server.url,
      token: makeToken(["admin_write"]),
    });
    server.stop();
    expect(result.exitCode).toBe(7);
    expect(server.requests).toHaveLength(0);
  });

  test("update-settings injects its action value", async () => {
    const server = startMockServer(() => ({ toolPayload: { ok: true } }));
    const result = await runCli({
      args: ["organization", "update-settings", "--matter-number-padding", "4"],
      url: server.url,
      token: makeToken(["admin_write"]),
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(server.requests.at(0)?.params.arguments).toEqual({
      action: "update_org_settings",
      matter_number_padding: 4,
    });
  });
});

describe("legislation multi-shape rendering (Phase 4)", () => {
  test("search-mode list renders the items Page envelope", async () => {
    const server = startMockServer(() => ({
      toolPayload: {
        items: [{ id: "l1", title: "Act 1" }],
        nextCursor: null,
      },
    }));
    const result = await runCli({
      args: ["legislation", "search", "--query", "tax", "--table"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("l1");
    expect(result.stdout).toContain("Act 1");
  });

  test("read-mode single block shape renders without crashing the table path", async () => {
    // No `items` array: the payload is a single block; the table path must fall
    // back to a key/value object render, not throw.
    const server = startMockServer(() => ({
      toolPayload: { law_id: "l1", block_id: "b1", text: "Section text" },
    }));
    const result = await runCli({
      args: ["legislation", "search", "--law-id", "l1", "--table"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("law_id");
    expect(result.stdout).toContain("Section text");
  });
});

describe("audit-log Page envelope (Phase 4)", () => {
  test("audit-log list renders the items array as rows", async () => {
    const server = startMockServer(() => ({
      toolPayload: {
        items: [{ action: "matter.create", user_id: "u1" }],
        nextCursor: "next",
      },
    }));
    const result = await runCli({
      args: ["audit-log", "list", "--table"],
      url: server.url,
      token: makeToken(["admin_read"]),
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("matter.create");
    expect(result.stderr).toContain("more: --cursor next");
  });
});

describe("feature-disabled exit class (S4/Phase 4)", () => {
  test("a plain-text feature error has no machine code and falls to exit 4", async () => {
    const server = startMockServer(() => ({
      toolPayload: "This feature is not enabled on this deployment",
      isError: true,
    }));
    const result = await runCli({
      args: ["time-entry", "list"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("not enabled");
  });

  test("a tagged feature-disabled machine code maps to exit 5", async () => {
    const server = startMockServer(() => ({
      toolPayload: { code: "feature_disabled", message: "disabled" },
      isError: true,
    }));
    const result = await runCli({
      args: ["time-entry", "list"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(5);
  });
});

describe("structured error envelope -> exit codes (S4)", () => {
  const envelopeError = (code: string, hint?: string): MockResponse => ({
    toolPayload: {
      error: {
        code,
        message: `Something went wrong: ${code}`,
        ...(hint === undefined ? {} : { hint }),
      },
    },
    isError: true,
  });

  test("feature_disabled envelope prints error:/hint: on stderr and exits 5", async () => {
    const server = startMockServer(() =>
      envelopeError("feature_disabled", "Enable billing for this org"),
    );
    const result = await runCli({
      args: ["time-entry", "list"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain(
      "error: Something went wrong: feature_disabled",
    );
    expect(result.stderr).toContain("hint: Enable billing for this org");
    // The raw JSON envelope must never leak to stdout.
    expect(result.stdout).toBe("");
  });

  test("not_found envelope exits 6", async () => {
    const server = startMockServer(() => envelopeError("not_found"));
    const result = await runCli({
      args: ["matter", "list"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain("error: Something went wrong: not_found");
  });

  test("missing_scope envelope (server-side) exits 3", async () => {
    const server = startMockServer(() => envelopeError("missing_scope"));
    const result = await runCli({
      args: ["matter", "list"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(3);
  });

  test("confirmation_required envelope exits 7", async () => {
    const server = startMockServer(() =>
      envelopeError("confirmation_required"),
    );
    const result = await runCli({
      args: ["matter", "list"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(7);
  });

  test("validation_error envelope exits 2, even with --output json", async () => {
    const server = startMockServer(() => envelopeError("validation_error"));
    const result = await runCli({
      args: ["matter", "list", "--output", "json"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(2);
    // stderr stays human-readable; the error is never dumped to stdout.
    expect(result.stderr).toContain(
      "error: Something went wrong: validation_error",
    );
    expect(result.stdout).toBe("");
  });
});

describe("destructive confirm injection (S4)", () => {
  test("a confirmed delete injects confirm: true into the tool args", async () => {
    const server = startMockServer(() => ({ toolPayload: { deleted: true } }));
    const result = await runCli({
      args: ["matter", "delete", "--matter-id", "m1", "--yes"],
      url: server.url,
      token: WRITE,
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(server.requests.at(0)?.params.name).toBe("delete_matter");
    expect(server.requests.at(0)?.params.arguments).toEqual({
      matter_id: "m1",
      confirm: true,
    });
  });

  test("a confirmed remove-member injects confirm: true alongside the action", async () => {
    // remove_member is destructive via the CLI annotation AND the tool schema
    // now declares the `confirm` gate, so --yes both skips the prompt and
    // injects confirm: true to satisfy the server's action-level gate.
    const server = startMockServer(() => ({ toolPayload: { removed: true } }));
    const result = await runCli({
      args: [
        "organization",
        "remove-member",
        "--matter-id",
        "m1",
        "--user-id",
        "u1",
        "--yes",
      ],
      url: server.url,
      token: makeToken(["admin_write"]),
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(server.requests.at(0)?.params.name).toBe("manage_organization");
    expect(server.requests.at(0)?.params.arguments).toEqual({
      action: "remove_member",
      matter_id: "m1",
      user_id: "u1",
      confirm: true,
    });
  });

  test("capability invoke --yes injects confirm: true (confirm passthrough)", async () => {
    // invoke_capability's leaf is non-destructive (destructiveness is
    // per-invoked-capability), but its confirmPassthrough annotation registers
    // --yes and injects the confirm gate upfront.
    const server = startMockServer(() => ({ toolPayload: { ok: true } }));
    const result = await runCli({
      args: [
        "capability",
        "invoke",
        "--capability",
        "clauses.categories-delete",
        "--yes",
      ],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(server.requests.at(0)?.params.name).toBe("invoke_capability");
    expect(server.requests.at(0)?.params.arguments).toEqual({
      capability: "clauses.categories-delete",
      confirm: true,
    });
  });

  test("capability invoke without --yes off a TTY exits 7 on confirmation_required", async () => {
    const server = startMockServer(() => ({
      toolPayload: {
        error: {
          code: "confirmation_required",
          message: "This capability is irreversible",
        },
      },
      isError: true,
    }));
    const result = await runCli({
      args: [
        "capability",
        "invoke",
        "--capability",
        "clauses.categories-delete",
      ],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(7);
    // No prompt and no retry off a TTY: exactly one server call, without confirm.
    expect(server.requests).toHaveLength(1);
    expect(server.requests.at(0)?.params.arguments).toEqual({
      capability: "clauses.categories-delete",
    });
  });
});

describe("feedback two-phase handshake (S4)", () => {
  test("phase-1 approval_required renders the confirmation_token", async () => {
    // Off a TTY (piped stdout) the phase-1 single object renders as JSON on
    // stdout with the token; the TTY-only re-run affordance is covered by the
    // approvalReRunHint unit test.
    const server = startMockServer(() => ({
      toolPayload: {
        channel: "email",
        status: "approval_required",
        sanitized_title: "Bug: crash",
        sanitized_body: "Steps ...",
        redactions: 0,
        confirmation_token: "tok-abc",
        expires_in_minutes: 15,
        next_step: "Show the human and re-run with the token.",
      },
    }));
    const result = await runCli({
      args: [
        "feedback",
        "send",
        "--kind",
        "bug",
        "--title",
        "Bug: crash",
        "--body",
        "Steps ...",
        "--channel",
        "email",
      ],
      url: server.url,
      token: makeToken(["feedback"]),
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(server.requests.at(0)?.params.name).toBe("send_feedback");
    const payload = JSON.parse(result.stdout);
    expect(payload.status).toBe("approval_required");
    expect(payload.confirmation_token).toBe("tok-abc");
  });

  test("phase-2 with --confirmation-token forwards the token to the server", async () => {
    const server = startMockServer(() => ({
      toolPayload: {
        channel: "email",
        status: "sent",
        next_step: "Tell the human it was emailed.",
      },
    }));
    const result = await runCli({
      args: [
        "feedback",
        "send",
        "--kind",
        "bug",
        "--title",
        "Bug: crash",
        "--body",
        "Steps ...",
        "--channel",
        "email",
        "--confirmation-token",
        "tok-abc",
      ],
      url: server.url,
      token: makeToken(["feedback"]),
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(server.requests.at(0)?.params.arguments).toEqual({
      kind: "bug",
      title: "Bug: crash",
      body: "Steps ...",
      channel: "email",
      confirmation_token: "tok-abc",
    });
  });
});

describe("reference resources (S5.4/Phase 4)", () => {
  test("reference list renders the resource table", async () => {
    const server = startMockServer(() => ({
      rpcResult: {
        resources: [
          {
            uri: "stella://reference/template-markers",
            name: "template-markers",
            title: "Template marker grammar",
            mimeType: "text/markdown",
          },
        ],
      },
    }));
    const result = await runCli({
      args: ["reference", "list", "--table"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(server.requests.at(0)?.method).toBe("resources/list");
    expect(result.stdout).toContain("template-markers");
    expect(result.stdout).toContain("text/markdown");
  });

  test("reference show template-markers reads its URI and prints contents[0].text", async () => {
    const server = startMockServer(() => ({
      rpcResult: {
        contents: [
          {
            uri: "stella://reference/template-markers",
            mimeType: "text/markdown",
            text: "# Marker grammar",
          },
        ],
      },
    }));
    const result = await runCli({
      args: ["reference", "show", "template-markers"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(server.requests.at(0)?.method).toBe("resources/read");
    expect(server.requests.at(0)?.params).toMatchObject({
      uri: "stella://reference/template-markers",
    });
    expect(result.stdout.trim()).toBe("# Marker grammar");
  });

  test("an unknown resource (server rejection) maps to exit 6", async () => {
    const server = startMockServer(() => ({
      rpc: { code: -32_602, message: "Unknown resource: stella://x" },
    }));
    const result = await runCli({
      args: ["reference", "show", "template-markers"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain("Unknown resource");
  });
});
