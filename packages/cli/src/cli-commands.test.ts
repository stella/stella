import { panic } from "better-result";
// End-to-end command tests (spec 051 S6): each MVP command is driven through the
// real stricli-built CLI (`bun cli.ts ...`) against an in-process mock MCP
// endpoint. `Bun.spawn` (async) is used, not `spawnSync`, so the in-process
// `Bun.serve` can answer requests concurrently. No real network origin is hit.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { respondToMcpLifecycle } from "../tests/mcp-test-lifecycle.js";
import { loadBakedCapabilityCatalog } from "./capability-catalog-load.js";
import { generatedToolAnnotations } from "./generated/tool-annotations.js";
import { EXIT_CODES } from "./mcp-constants.js";
import { validateFetchedToolsList } from "./registry-trust.js";

const CLI_ENTRYPOINT = path.join(import.meta.dirname, "cli.ts");
const FETCH_PRELOAD = path.join(
  import.meta.dirname,
  "../tests/cli-command-fetch.ts",
);
const registry = validateFetchedToolsList(
  await Bun.file(
    new URL("generated/registry-snapshot.json", import.meta.url),
  ).text(),
);
if (!registry.ok) {
  panic(`Invalid committed command-test registry: ${registry.violation}`);
}
const catalog = loadBakedCapabilityCatalog();
if (catalog === null) {
  panic("Invalid committed command-test capability catalog");
}
// Command-behaviour tests exercise an admitted principal. Build its discovery
// response from the shipped contract so new feature-owned commands cannot drift.
const registryResult = {
  tools: registry.listings.map((listing) => {
    const featureId = generatedToolAnnotations[listing.name]?.featureId;
    return {
      ...listing,
      ...(featureId === undefined ? {} : { _meta: { featureId } }),
    };
  }),
  _meta: {
    featureAccess: {
      tools: registry.listings.flatMap((listing) =>
        generatedToolAnnotations[listing.name]?.featureId === undefined
          ? []
          : [listing.name],
      ),
      capabilities: catalog.flatMap((entry) =>
        entry.featureId === undefined ? [] : [entry.id],
      ),
    },
  },
};

// These tests start a fresh Bun process for each real CLI invocation. Startup
// can exceed Bun's 5-second default while the repository suite is contended.
setDefaultTimeout(15_000);

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

type PutHandler = (request: Request) => Response | Promise<Response>;

type StartMockServerOptions = {
  putHandler?: PutHandler;
  deploymentEvidence?: "available" | "unknown";
};

const startMockServer = (
  handler: MockHandler,
  { putHandler, deploymentEvidence = "available" }: StartMockServerOptions = {},
) => {
  const requests: JsonRpcRequest[] = [];
  const discoveries: JsonRpcRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method === "GET") {
        return new Response(null, { status: 405 });
      }
      if (req.method === "PUT") {
        return putHandler === undefined
          ? new Response("unexpected PUT", { status: 405 })
          : await putHandler(req);
      }
      const body: JsonRpcRequest = JSON.parse(await req.text());
      const lifecycle = respondToMcpLifecycle(body);
      if (lifecycle !== null) {
        return lifecycle;
      }
      if (body.method === "tools/list") {
        discoveries.push(body);
        return Response.json(
          { jsonrpc: "2.0", id: 1, result: registryResult },
          {
            headers:
              deploymentEvidence === "available"
                ? {
                    "x-stella-feature-omitted-tools": "",
                    "x-stella-feature-omitted-capabilities": "",
                  }
                : {},
          },
        );
      }
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
    discoveries,
    url: server.url.origin,
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
  expiresAt,
}: {
  configHome: string;
  url: string;
  token: string;
  expiresAt?: number | undefined;
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
        expiresAt: expiresAt ?? now + 3_600_000,
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
  expiresAt,
  serverUrlEnv,
}: {
  args: readonly string[];
  url: string;
  token: string;
  stdin?: string;
  signedIn?: boolean;
  expiresAt?: number | undefined;
  /** `STELLA_SERVER_URL` when the test needs it to differ from the credential's server. */
  serverUrlEnv?: string;
}): Promise<RunResult> => {
  const configHome = await mkdtemp(path.join(tmpdir(), "stella-cli-"));
  tempDirs.push(configHome);
  if (signedIn) {
    await writeCredentials({ configHome, url, token, expiresAt });
  }

  const proc = Bun.spawn({
    cmd: ["bun", "--preload", FETCH_PRELOAD, CLI_ENTRYPOINT, ...args],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
      XDG_CACHE_HOME: path.join(configHome, "cache"),
      STELLA_API_KEY: undefined,
      STELLA_SERVER_URL: serverUrlEnv ?? url,
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
// A new document spends the uploads domain consent and the documents consent.
const DOCUMENT_UPLOAD = makeToken(["read", "matters_write", "documents_write"]);

describe("--server (every command)", () => {
  test("a generated command targets the origin the flag names", async () => {
    const server = startMockServer(() => ({
      toolPayload: { matters: [{ id: "m1", name: "Acme" }] },
    }));
    const result = await runCli({
      args: ["matter", "list", "--server", server.url, "--json"],
      url: server.url,
      // The env tier points somewhere unusable, so a pass means the flag (read
      // before dispatch) selected the origin, not the fallback.
      serverUrlEnv: "http://127.0.0.1:1",
      token: READ,
    });
    server.stop();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("--server");
    expect(server.requests).toHaveLength(1);
  });

  test("compatibility check falls back to STELLA_SERVER_URL", async () => {
    const server = startMockServer(() => ({ toolPayload: {} }));
    const result = await runCli({
      args: ["compatibility", "check"],
      url: server.url,
      token: READ,
      signedIn: false,
    });
    server.stop();

    // The mock has no compatibility contract, so the check fails — but on the
    // resolved origin, not on stricli's "expected input for flag" usage error.
    expect(result.stderr).toContain(server.url);
    expect(result.stderr).not.toContain("--server");
  });
});

describe("one-command document upload", () => {
  test("discovers, reserves, PUTs and finalizes without external curl", async () => {
    const uploadDir = await mkdtemp(path.join(tmpdir(), "stella-upload-"));
    tempDirs.push(uploadDir);
    const filePath = path.join(uploadDir, "agreement.txt");
    await writeFile(filePath, "agreement body");
    const putBodies: string[] = [];
    const putChecksums: string[] = [];
    let putUrl = "";
    const server = startMockServer(
      (request, index) => {
        const capability = request.params.arguments?.["capability"];
        if (index === 0 && capability === "properties.list") {
          return {
            toolPayload: [
              { id: "property-text", content: { type: "text" } },
              { id: "property-file", content: { type: "file" } },
            ],
          };
        }
        if (index === 1 && capability === "uploads.create") {
          return {
            toolPayload: {
              uploadId: "upload-1",
              url: putUrl,
              headers: {
                "content-type": "text/plain",
                "x-amz-checksum-sha256": "signed-checksum",
              },
            },
          };
        }
        return {
          toolPayload: {
            finalizedResult: {
              type: "entity_create",
              entityId: "entity-1",
              fileName: "agreement.txt",
            },
          },
        };
      },
      {
        putHandler: async (request) => {
          putBodies.push(await request.text());
          putChecksums.push(request.headers.get("x-amz-checksum-sha256") ?? "");
          return new Response(null, { status: 200 });
        },
      },
    );
    putUrl = `${server.url}/presigned/upload-1`;

    const result = await runCli({
      args: [
        "upload",
        "--matter-id",
        "workspace-1",
        "--file",
        filePath,
        "--json",
      ],
      url: server.url,
      token: DOCUMENT_UPLOAD,
    });
    server.stop();

    expect(result.exitCode).toBe(0);
    // The finalize envelope's outcome alone, shaped like every other save.
    expect(JSON.parse(result.stdout)).toEqual({
      type: "entity_create",
      entityId: "entity-1",
      fileName: "agreement.txt",
    });
    expect(result.stderr).toBe("");
    expect(putBodies).toEqual(["agreement body"]);
    expect(putChecksums).toEqual(["signed-checksum"]);
    expect(
      server.requests.map(
        (request) => request.params.arguments?.["capability"],
      ),
    ).toEqual(["properties.list", "uploads.create", "uploads.update"]);
    expect(server.requests.at(1)?.params.arguments?.["input"]).toEqual({
      body: {
        purpose: "entity_create",
        propertyId: "property-file",
        name: "agreement.txt",
        mimeType: "text/plain",
        size: Buffer.byteLength("agreement body"),
        // Independent of the CLI helper: SHA-256 of "agreement body".
        sha256Hex:
          "e1312950a806cda855e53f603301c78c3c23ea486e1beca337731fdba766720a",
      },
      params: { matterId: "workspace-1" },
    });
  });

  test("help explains the entire local-file workflow", async () => {
    const server = startMockServer(() => ({ toolPayload: {} }));
    const result = await runCli({
      args: ["upload", "--help"],
      url: server.url,
      token: DOCUMENT_UPLOAD,
    });
    server.stop();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--file");
    expect(result.stdout).toContain("--matter-id");
    expect(result.stdout).toContain("--json");
    expect(result.stdout).toContain("computes its SHA-256 checksum");
    expect(server.requests).toHaveLength(0);
  });

  test("finalize failures print the canonical namespaced retry command", async () => {
    const uploadDir = await mkdtemp(path.join(tmpdir(), "stella-upload-"));
    tempDirs.push(uploadDir);
    const filePath = path.join(uploadDir, "agreement.txt");
    await writeFile(filePath, "agreement body");
    let putUrl = "";
    const server = startMockServer(
      (request, index) => {
        const capability = request.params.arguments?.["capability"];
        if (index === 0 && capability === "uploads.create") {
          return {
            toolPayload: {
              uploadId: "upload-1",
              url: putUrl,
              headers: { "content-type": "text/plain" },
            },
          };
        }
        return { toolPayload: { message: "finalize failed" }, isError: true };
      },
      { putHandler: () => new Response(null, { status: 200 }) },
    );
    putUrl = `${server.url}/presigned/upload-1`;

    const result = await runCli({
      args: [
        "upload",
        "--matter-id",
        "workspace-1",
        "--file",
        filePath,
        "--property-id",
        "property-file",
      ],
      url: server.url,
      token: DOCUMENT_UPLOAD,
    });
    server.stop();

    expect(result.stderr).toContain(
      "stella capability uploads update --matter-id workspace-1 --upload-id upload-1",
    );
    expect(result.stderr).not.toContain("stella uploads update");
  });
});

describe("contact discovery", () => {
  test("lists internal contact ids through the curated MCP tool", async () => {
    const server = startMockServer((request) => {
      expect(request.params.name).toBe("list_contacts");
      expect(request.params.arguments).toEqual({ limit: 1, q: "Acme" });
      return {
        toolPayload: {
          items: [
            {
              id: "contact-1",
              displayName: "Acme Corp",
              type: "organization",
            },
          ],
          limit: 1,
          nextCursor: null,
        },
      };
    });

    const result = await runCli({
      args: ["contact", "list", "--query", "Acme", "--limit", "1", "--json"],
      url: server.url,
      token: READ,
    });
    server.stop();

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).items.at(0)?.id).toBe("contact-1");
    expect(result.stderr).toBe("");
  });
});

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

  test("an expired credential with no refresh token surfaces the specific refresh-failed reason, not just 'Not signed in'", async () => {
    const server = startMockServer(() => ({ toolPayload: {} }));
    const result = await runCli({
      args: ["matter", "list"],
      url: server.url,
      token: READ,
      // No refresh token is ever written by `writeCredentials`, so an
      // already-expired token fails closed without any network call
      // (see `resolveAccessToken`'s "Expired and unrefreshable" branch).
      expiresAt: Date.now() - 1000,
    });
    server.stop();
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("Not signed in");
    // The specific reason (the stored token expired and has no refresh
    // token) must reach the user instead of being silently discarded by
    // `resolvePreamble`.
    expect(result.stderr).toContain(
      "no refresh token is available. Run `stella auth login` again.",
    );
    expect(server.requests).toHaveLength(0);
  });
});

describe("generated capability flags", () => {
  test("personal history omitting kind sends an unfiltered request", async () => {
    const server = startMockServer(() => ({
      toolPayload: { items: [], nextCursor: null, limit: 20 },
    }));
    const result = await runCli({
      args: ["capability", "search-history", "list", "--limit", "20", "--json"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(server.requests).toHaveLength(1);
    expect(server.requests.at(0)?.params.name).toBe("invoke_capability");
    expect(server.requests.at(0)?.params.arguments).toEqual({
      capability: "search-history.list",
      input: { query: { limit: 20 } },
    });
  });

  test("personal history explicit kind sends only the requested filter", async () => {
    const server = startMockServer(() => ({
      toolPayload: { items: [], nextCursor: null, limit: 20 },
    }));
    const result = await runCli({
      args: [
        "capability",
        "search-history",
        "list",
        "--limit",
        "20",
        "--kind",
        "decision",
        "--json",
      ],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(server.requests).toHaveLength(1);
    expect(server.requests.at(0)?.params.arguments).toEqual({
      capability: "search-history.list",
      input: { query: { limit: 20, kind: "decision" } },
    });
  });

  test("a descriptive long flag can target a terse query property", async () => {
    const server = startMockServer(() => ({ toolPayload: { items: [] } }));
    const result = await runCli({
      args: ["capability", "contacts", "search", "--query", "agreement"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(server.requests.at(0)?.params.name).toBe("read_capability");
    expect(server.requests.at(0)?.params.arguments).toEqual({
      capability: "contacts.search",
      input: { query: { q: "agreement" } },
    });
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
  test("document content prints raw document text", async () => {
    const server = startMockServer(() => ({
      toolPayload: { name: "Doc", text: "THE FULL BODY", nextCursor: null },
    }));
    const result = await runCli({
      args: ["document", "content", "--entity-id", "e1"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("THE FULL BODY");
  });

  test("a read that nests its subject prints the nested text", async () => {
    // read_statute answers `{ nextCursor, statute: { text } }`. A runtime that
    // only looked at a top-level `text` printed nothing here.
    const server = startMockServer(() => ({
      toolPayload: {
        nextCursor: null,
        statute: {
          charCount: 13,
          eli: "/eli/cz/sb/2012/89",
          text: "THE STATUTE BODY",
          truncated: false,
        },
      },
    }));
    const result = await runCli({
      args: ["legislation", "read", "--eli", "/eli/cz/sb/2012/89"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("THE STATUTE BODY");
  });

  test("--all concatenates the nested windows of a statute read", async () => {
    const server = startMockServer((_body, index) => ({
      toolPayload:
        index === 0
          ? { nextCursor: "w2", statute: { text: "FIRST ", truncated: true } }
          : { nextCursor: null, statute: { text: "SECOND", truncated: false } },
    }));
    const result = await runCli({
      args: ["legislation", "read", "--eli", "/eli/cz/sb/2012/89", "--all"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("FIRST SECOND");
    expect(server.requests).toHaveLength(2);
    expect(server.requests.at(1)?.params.arguments).toMatchObject({
      cursor: "w2",
    });
  });

  for (const format of ["json", "jsonl"] as const) {
    for (const held of [true, false]) {
      test(`--all ${format} preserves ${held ? "held" : "external"} legal citation links from the first window`, async () => {
        const source = "https://publisher.example/act/89-2012";
        const links = held
          ? {
              url: "https://app.example/law/cze/statutes/89-2012-sb/v/2014-01-01#par_1729",
              source_url: source,
            }
          : { url: source };
        const server = startMockServer((_body, index) => ({
          toolPayload:
            index === 0
              ? {
                  nextCursor: "w2",
                  statute: { text: "FIRST ", truncated: true, ...links },
                }
              : {
                  nextCursor: null,
                  statute: { text: "SECOND", truncated: false },
                },
        }));
        try {
          const result = await runCli({
            args: [
              "legislation",
              "read",
              "--eli",
              "/eli/cz/sb/2012/89",
              "--all",
              "--output",
              format,
            ],
            url: server.url,
            token: READ,
          });
          expect(result.exitCode).toBe(0);
          expect(JSON.parse(result.stdout)).toEqual({
            text: "FIRST SECOND",
            ...links,
          });
          expect(server.requests).toHaveLength(2);
          expect(server.requests.at(1)?.params.arguments).toMatchObject({
            cursor: "w2",
          });
        } finally {
          server.stop();
        }
      });
    }
  }
  test("a read the server states has no text exits 0 with a typed field, not empty text", async () => {
    const server = startMockServer(() => ({
      toolPayload: {
        nextCursor: null,
        statute: {
          eli: "/eli/cz/sb/2012/89",
          text: null,
          textWithheldReason: "The source licence does not permit it.",
        },
      },
    }));
    const result = await runCli({
      args: ["legislation", "read", "--eli", "/eli/cz/sb/2012/89", "--json"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(EXIT_CODES.ok);
    expect(JSON.parse(result.stdout)).toEqual({
      text: null,
      textUnavailable: { reason: "no_text", textPath: "statute.text" },
      response: {
        nextCursor: null,
        statute: {
          eli: "/eli/cz/sb/2012/89",
          text: null,
          textWithheldReason: "The source licence does not permit it.",
        },
      },
    });
    expect(result.stderr).toContain("No text");
  });

  test("a response without the text the command reads fails loudly instead of printing empty text", async () => {
    // A command built for one response shape reading another: here a batch
    // envelope answering a single-text leaf, the shape that printed
    // `{"text":""}` with exit 0 before. The response is kept, not dropped.
    const items = [
      {
        decisionId: "00000000-0000-4000-8000-000000000001",
        status: "found",
        decision: { text: "THE DECISION BODY" },
      },
    ];
    const server = startMockServer(() => ({ toolPayload: { items } }));
    const result = await runCli({
      args: ["document", "content", "--entity-id", "e1", "--json"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(EXIT_CODES.unexpected);
    expect(JSON.parse(result.stdout)).toEqual({
      text: null,
      textUnavailable: { reason: "not_in_response", textPath: "text" },
      response: { items },
    });
    expect(result.stderr).toContain("npm i -g @stll/cli");
  });

  test("--all stops at a first window without text and types it", async () => {
    const server = startMockServer(() => ({
      toolPayload: {
        nextCursor: "w2",
        statute: { text: null, textWithheldReason: "withheld" },
      },
    }));
    const result = await runCli({
      args: [
        "legislation",
        "read",
        "--eli",
        "/eli/cz/sb/2012/89",
        "--all",
        "--json",
      ],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(EXIT_CODES.ok);
    expect(server.requests).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      text: null,
      textUnavailable: { reason: "no_text", textPath: "statute.text" },
    });
  });

  test("a case-law decision read renders one entry per requested id", async () => {
    // Not a windowed-text leaf: the read answers per entry, so both the text
    // and its continuation cursor are per entry and there is no one window to
    // print or to follow. The two statute reads above cover `textPath`.
    const server = startMockServer(() => ({
      toolPayload: {
        items: [
          {
            decisionId: "00000000-0000-4000-8000-000000000001",
            nextCursor: null,
            status: "found",
            decision: {
              caseNumber: "29 Cdo 1/2024",
              text: "THE DECISION BODY",
            },
          },
          {
            decisionId: "00000000-0000-4000-8000-000000000002",
            message: "No decision the public may read has this id.",
            status: "not_found",
          },
        ],
      },
    }));
    const result = await runCli({
      args: [
        "case-law",
        "read",
        "--decision-ids",
        "00000000-0000-4000-8000-000000000001",
        "--decision-ids",
        "00000000-0000-4000-8000-000000000002",
        "--json",
      ],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    const printed = JSON.parse(result.stdout);
    expect(
      printed.items.map((item: { status: string }) => item.status),
    ).toEqual(["found", "not_found"]);
    expect(printed.items.at(0).decision.text).toBe("THE DECISION BODY");
    expect(printed).not.toHaveProperty("text");
    expect(server.requests.at(0)?.params.arguments).toMatchObject({
      decision_ids: [
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      ],
    });
  });

  test("a decision read pages by number, so it offers neither --cursor nor --all", async () => {
    // Each decision of a batch is paged with `--page`; there is no cursor for
    // the follow loop to advance.
    const server = startMockServer(() => ({ toolPayload: { items: [] } }));
    const result = await runCli({
      args: [
        "case-law",
        "read",
        "--decision-ids",
        "00000000-0000-4000-8000-000000000001",
        "--all",
      ],
      url: server.url,
      token: READ,
    });
    const help = await runCli({
      args: ["case-law", "read", "--help"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(2);
    expect(server.requests).toHaveLength(0);
    expect(help.stdout).toContain("--page");
    expect(help.stdout).not.toContain("--cursor");
    expect(help.stdout).not.toContain("--all");
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

  test("an out-of-enum value reaches server validation", async () => {
    const server = startMockServer(() => ({
      toolPayload: {
        error: { code: "validation_error", message: "Invalid registry" },
      },
      isError: true,
    }));
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
    expect(server.requests.at(0)?.params.arguments).toEqual({
      query: "Acme",
      registry: "not-a-registry",
    });
  });

  test("nullable-string `null` is sent as JSON null", async () => {
    const server = startMockServer(() => ({
      toolPayload: { contactId: "c1" },
    }));
    const result = await runCli({
      args: [
        "contact",
        "save",
        "--contact-id",
        "c1",
        "--first-name",
        "null",
        "--yes",
      ],
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
      args: ["matter", "save", "--input", '{"name":"New Matter"}', "--yes"],
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
      args: ["matter", "save", "--input", "-", "--yes"],
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
      args: ["matter", "save", "--input", `@${file}`, "--yes"],
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

  test("--input composes with a value flag; the explicit flag wins over its path", async () => {
    const server = startMockServer(() => ({ toolPayload: {} }));
    const result = await runCli({
      args: [
        "matter",
        "save",
        "--input",
        '{"name":"FromJson"}',
        "--name",
        "FromFlag",
        "--yes",
      ],
      url: server.url,
      token: WRITE,
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    // The flag overrides the JSON's `name`; both are threaded to the server.
    expect(server.requests.at(0)?.params.arguments).toEqual({
      name: "FromFlag",
    });
  });

  test("--input defers schema validation to the server", async () => {
    const server = startMockServer(() => ({
      toolPayload: {
        error: { code: "validation_error", message: "Invalid status" },
      },
      isError: true,
    }));
    const result = await runCli({
      args: ["matter", "save", "--input", '{"status":"bogus"}', "--yes"],
      url: server.url,
      token: WRITE,
    });
    server.stop();
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Invalid status");
    expect(server.requests.at(0)?.params.arguments).toEqual({
      status: "bogus",
    });
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

  test("HTTP 403 -> exit 8", async () => {
    const server = startMockServer(() => ({ httpStatus: 403 }));
    const result = await runCli({
      args: ["matter", "list"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(8);
  });
  test("HTTP 409 -> exit 10", async () => {
    const server = startMockServer(() => ({ httpStatus: 409 }));
    const result = await runCli({
      args: ["matter", "list"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(10);
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
    // A field issue renders as `  <flag>: <message>`; a root issue (empty path)
    // renders its message without a bare `: ` prefix.
    expect(result.stderr).toContain("  --matter-id: Required");
    expect(result.stderr).toContain("  at least one filter is required");
  });
});

describe("help surfaces --input for inputOnly tools", () => {
  test("template fill --help renders its free-map shape and a complete example", async () => {
    const server = startMockServer(() => ({ toolPayload: {} }));
    const result = await runCli({
      args: ["template", "fill", "--help"],
      url: server.url,
      token: makeToken(["templates"]),
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("values.<key>  any JSON value  required");
    expect(result.stdout).toContain("--completion-mode");
    expect(result.stdout).toContain("require_complete");
    expect(result.stdout).toContain("allow_partial");
    expect(result.stdout).toContain(
      `--input '{"template_id":"00000000-0000-4000-8000-000000000000","values":{"key":"value"}}'`,
    );
  });

  test("uploads create --help renders every union branch from the schema", async () => {
    const server = startMockServer(() => ({ toolPayload: {} }));
    const result = await runCli({
      args: ["capability", "uploads", "create", "--help"],
      url: server.url,
      token: WRITE,
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('purpose = "entity_create"');
    expect(result.stdout).toContain('purpose = "entity_version"');
    expect(result.stdout).toContain('purpose = "agent_skill"');
    expect(result.stdout).toContain("body.sha256Hex  string  required");
    expect(result.stdout).toContain('"params":{"matterId":"xxxxx"}');
  });

  test("template configure-fields --help documents the --input-only fields", async () => {
    const server = startMockServer(() => ({ toolPayload: {} }));
    const result = await runCli({
      args: ["template", "configure-fields", "--help"],
      url: server.url,
      token: makeToken(["templates"]),
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--input");
    expect(result.stdout).toContain("fields");
  });

  test("template save-filled help uses the selected destination in its example", async () => {
    const server = startMockServer(() => ({ toolPayload: {} }));
    const result = await runCli({
      args: ["template", "save-filled", "new-version", "--help"],
      url: server.url,
      token: makeToken(["documents_write"]),
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"action":"create_version"');
    expect(result.stdout).not.toContain('"action":"create_document"');
  });

  test("clause save --help documents its --input-only fields", async () => {
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
    expect(result.stdout).toContain("expected_body");
    expect(result.stdout).toContain("metadata");
  });
});

describe("template fill strictness policies", () => {
  test("surfaces the tool's strict unused-value error", async () => {
    const server = startMockServer(() => ({
      toolPayload: {
        error: {
          code: "validation_error",
          message: "Unused template value keys: typo",
          issues: [
            {
              path: "values.typo",
              message: "Value key does not match a template field",
            },
          ],
          hint: "Correct the value keys or explicitly allow unused values.",
        },
      },
      isError: true,
    }));
    const result = await runCli({
      args: [
        "template",
        "fill",
        "--template-id",
        "11111111-1111-4111-8111-111111111111",
        "--input",
        '{"values":{"typo":"value"}}',
      ],
      url: server.url,
      token: makeToken(["templates"]),
    });
    server.stop();

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unused template value keys: typo");
    expect(server.requests).toHaveLength(1);
  });

  test("forwards the explicit unused-value override to the shared MCP tool", async () => {
    const fillPayload = {
      documentBase64: "ZmlsbGVk",
      unusedValues: ["intentional"],
    };
    const server = startMockServer(() => ({ toolPayload: fillPayload }));
    const result = await runCli({
      args: [
        "template",
        "fill",
        "--template-id",
        "11111111-1111-4111-8111-111111111111",
        "--input",
        '{"values":{"intentional":"value"}}',
        "--allow-unused-values",
      ],
      url: server.url,
      token: makeToken(["templates"]),
    });
    server.stop();

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(fillPayload);
    expect(server.requests.at(0)?.params.arguments).toEqual({
      template_id: "11111111-1111-4111-8111-111111111111",
      values: { intentional: "value" },
      allow_unused_values: true,
    });
  });

  test("forwards the explicit partial-completion policy to the shared MCP tool", async () => {
    const server = startMockServer(() => ({
      toolPayload: {
        completionStatus: "partial",
        unmatchedPlaceholders: ["signature"],
      },
    }));
    const result = await runCli({
      args: [
        "template",
        "fill",
        "--template-id",
        "11111111-1111-4111-8111-111111111111",
        "--input",
        '{"values":{"name":"ACME"}}',
        "--completion-mode",
        "allow_partial",
      ],
      url: server.url,
      token: makeToken(["templates"]),
    });
    server.stop();

    expect(result.exitCode).toBe(0);
    expect(server.requests.at(0)?.params.arguments).toEqual({
      template_id: "11111111-1111-4111-8111-111111111111",
      values: { name: "ACME" },
      completion_mode: "allow_partial",
    });
  });
});

describe("template persistence discriminator split", () => {
  test("requires template consent as well as document-write consent", async () => {
    const server = startMockServer(() => ({
      toolPayload: {
        entityId: "33333333-3333-4333-8333-333333333333",
        versionNumber: 2,
      },
    }));
    const result = await runCli({
      args: [
        "template",
        "save-filled",
        "new-version",
        "--template-id",
        "11111111-1111-4111-8111-111111111111",
        "--matter-id",
        "22222222-2222-4222-8222-222222222222",
        "--entity-id",
        "33333333-3333-4333-8333-333333333333",
        "--idempotency-key",
        "retry_1",
        "--input",
        '{"values":{"tenant.name":"ACME"}}',
        "--yes",
      ],
      url: server.url,
      token: makeToken(["documents_write"]),
    });
    server.stop();

    expect(result.exitCode).toBe(EXIT_CODES.auth);
    expect(result.stderr).toContain("Missing scope stella:templates");
    expect(result.stderr).toContain(
      "stella auth login --scopes stella:documents_write,stella:templates",
    );
    expect(server.requests).toHaveLength(0);
  });

  test("new-version injects the destination and forwards values through --input", async () => {
    const server = startMockServer(() => ({
      toolPayload: {
        entityId: "33333333-3333-4333-8333-333333333333",
        versionNumber: 2,
      },
    }));
    const result = await runCli({
      args: [
        "template",
        "save-filled",
        "new-version",
        "--template-id",
        "11111111-1111-4111-8111-111111111111",
        "--matter-id",
        "22222222-2222-4222-8222-222222222222",
        "--entity-id",
        "33333333-3333-4333-8333-333333333333",
        "--idempotency-key",
        "retry_1",
        "--input",
        '{"values":{"tenant.name":"ACME"}}',
        "--yes",
      ],
      url: server.url,
      token: makeToken(["documents_write", "templates"]),
    });
    server.stop();

    expect(result.exitCode).toBe(0);
    expect(server.requests.at(0)?.params.name).toBe("save_filled_template");
    expect(server.requests.at(0)?.params.arguments).toEqual({
      action: "create_version",
      template_id: "11111111-1111-4111-8111-111111111111",
      matter_id: "22222222-2222-4222-8222-222222222222",
      entity_id: "33333333-3333-4333-8333-333333333333",
      idempotency_key: "retry_1",
      values: { "tenant.name": "ACME" },
    });
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
        "w1",
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
      matter_id: "w1",
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
        "w1",
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

  test("update-settings forwards the document processing mode", async () => {
    const server = startMockServer(() => ({ toolPayload: { ok: true } }));
    const result = await runCli({
      args: [
        "organization",
        "update-settings",
        "--document-processing-mode",
        "searchable-text",
      ],
      url: server.url,
      token: makeToken(["admin_write"]),
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(server.requests.at(0)?.params.arguments).toEqual({
      action: "update_org_settings",
      document_processing_mode: "searchable-text",
    });
  });
});

describe("BOE legislation multi-shape rendering (Phase 4)", () => {
  test("search-mode list renders the items Page envelope", async () => {
    const server = startMockServer(() => ({
      toolPayload: {
        items: [{ id: "l1", title: "Act 1" }],
        nextCursor: null,
      },
    }));
    const result = await runCli({
      args: ["legislation", "boe-search", "--query", "tax", "--table"],
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
      args: ["legislation", "boe-search", "--law-id", "l1", "--table"],
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
  test.each(["available", "unknown"] as const)(
    "current deployment evidence %s controls command admission",
    async (deploymentEvidence) => {
      const server = startMockServer(() => ({ toolPayload: { items: [] } }), {
        deploymentEvidence,
      });
      const result = await runCli({
        args: ["time-entry", "list"],
        url: server.url,
        token: READ,
      });
      server.stop();
      expect(server.discoveries).toHaveLength(1);
      expect(result.exitCode).toBe(
        deploymentEvidence === "available"
          ? EXIT_CODES.ok
          : EXIT_CODES.validation,
      );
      expect(server.requests).toHaveLength(
        deploymentEvidence === "available" ? 1 : 0,
      );
      if (deploymentEvidence === "available") {
        expect(server.requests.at(0)).toMatchObject({
          method: "tools/call",
          params: { name: "list_time_entries" },
        });
      }
    },
  );

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
    expect(server.discoveries).toHaveLength(1);
    expect(server.requests).toHaveLength(1);
    expect(server.requests.at(0)).toMatchObject({
      method: "tools/call",
      params: { name: "list_time_entries" },
    });
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
    expect(server.discoveries).toHaveLength(1);
    expect(server.requests).toHaveLength(1);
    expect(server.requests.at(0)).toMatchObject({
      method: "tools/call",
      params: { name: "list_time_entries" },
    });
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
    expect(server.discoveries).toHaveLength(1);
    expect(server.requests).toHaveLength(1);
    expect(server.requests.at(0)).toMatchObject({
      method: "tools/call",
      params: { name: "list_time_entries" },
    });
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
        "w1",
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
      matter_id: "w1",
      user_id: "u1",
      confirm: true,
    });
  });

  test("capability write --yes injects confirm: true (confirm passthrough)", async () => {
    // write_capability's leaf is non-destructive (destructiveness is
    // per-invoked-capability), but its confirmPassthrough annotation registers
    // --yes and injects the confirm gate upfront.
    const server = startMockServer(() => ({ toolPayload: { ok: true } }));
    const result = await runCli({
      args: [
        "capability",
        "write",
        "--capability",
        "clauses.categories.delete",
        "--yes",
      ],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(server.requests.at(0)?.params.name).toBe("write_capability");
    expect(server.requests.at(0)?.params.arguments).toEqual({
      capability: "clauses.categories.delete",
      confirm: true,
    });
  });

  test("capability write without --yes off a TTY exits 7 on confirmation_required", async () => {
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
        "write",
        "--capability",
        "clauses.categories.delete",
      ],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(7);
    // No prompt and no retry off a TTY: exactly one server call, without confirm.
    expect(server.requests).toHaveLength(1);
    expect(server.requests.at(0)?.params.arguments).toEqual({
      capability: "clauses.categories.delete",
    });
  });
});

describe("feedback (S4)", () => {
  const report = {
    kind: "bug",
    area: "templates",
    title: "Fill drops a repeated row",
    what_happened: "The second row of a repeated table is blank.",
  };
  const APPROVAL_TOKEN = `fb1.1800000000000.${"A".repeat(43)}`;
  const reportArgs = [
    "--kind",
    report.kind,
    "--area",
    report.area,
    "--title",
    report.title,
    "--what-happened",
    report.what_happened,
  ];

  test("prepare returns the sanitized report and sends nothing", async () => {
    const server = startMockServer(() => ({
      toolPayload: {
        report,
        approval_token: APPROVAL_TOKEN,
        redactions: 0,
        redacted_fields: [],
        next_step: "Show the report to the human, then call submit_feedback.",
      },
    }));
    const result = await runCli({
      args: ["feedback", "prepare", ...reportArgs],
      url: server.url,
      token: makeToken(["feedback"]),
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(server.requests.at(0)?.params.name).toBe("prepare_feedback");
    expect(server.requests.at(0)?.params.arguments).toEqual(report);
    expect(JSON.parse(result.stdout).report).toEqual(report);
  });

  test("submit --yes sends the approved report and prints the receipt", async () => {
    const server = startMockServer(() => ({
      toolPayload: {
        receipt: "FB-7K2M-9QXA",
        redactions: 0,
        deduplicated: false,
        deliveries: [{ channel: "email", status: "delivered" }],
        stored: true,
      },
    }));
    const result = await runCli({
      args: [
        "feedback",
        "submit",
        ...reportArgs,
        "--approval-token",
        APPROVAL_TOKEN,
        "--yes",
      ],
      url: server.url,
      token: makeToken(["feedback"]),
    });
    server.stop();
    expect(result.exitCode).toBe(0);
    expect(server.requests.at(0)?.params.name).toBe("submit_feedback");
    expect(server.requests.at(0)?.params.arguments).toEqual({
      ...report,
      approval_token: APPROVAL_TOKEN,
      confirm: true,
    });
    expect(JSON.parse(result.stdout).receipt).toBe("FB-7K2M-9QXA");
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

  test("an organization-access-denied resource read (HTTP 403) maps to exit 8", async () => {
    const server = startMockServer(() => ({ httpStatus: 403 }));
    const result = await runCli({
      args: ["reference", "show", "template-markers"],
      url: server.url,
      token: READ,
    });
    server.stop();
    expect(result.exitCode).toBe(8);
  });
});
