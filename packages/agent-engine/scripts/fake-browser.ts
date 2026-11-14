import { panic } from "better-result";
import * as v from "valibot";

import {
  BROWSER_CONTROL_CONTENT_TRUST,
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_CONTROL_TARGET_METADATA,
  BROWSER_EXTENSION_MESSAGE_SOURCE,
  type BrowserControlCommand,
  type BrowserControlErrorCode,
  type BrowserControlResult,
  parseBrowserDesktopRequest,
} from "@stll/api-contract/browser-control";

import {
  encodeNativeMessage,
  nativeMessageReader,
} from "../src/sidecar/browser/native-host";

/**
 * The pieces of the local browser canary that stand in for the outside
 * world: a fixture library site, Chrome with the stella extension (behind
 * the real native host), and an agent that searches the site, opens a
 * result and cites it. Nothing here reaches a model provider or the
 * internet.
 *
 * The library's pages hold canary strings in their text. The agent reads
 * them, as it reads any page, but never repeats them: any canary byte that
 * reaches stella's servers left the computer through the transport.
 */

export const FIXTURE_CANARIES = [
  "CANARY-7f3a-holding-text",
  "CANARY-9b21-party-name",
] as const;

const DECISION = {
  path: "/doc/12-c-345-2024",
  title: "Decision 12 C 345/2024",
} as const;

const FIXTURE_QUERY = "notice period";

const fixturePageSchema = v.object({
  title: v.string(),
  text: v.string(),
  elements: v.array(
    v.object({
      role: v.picklist(["searchbox", "textbox", "button", "link"]),
      name: v.string(),
      href: v.optional(v.string()),
    }),
  ),
  signIn: v.optional(v.literal(true)),
});

type FixturePage = v.InferOutput<typeof fixturePageSchema>;

/** The library's pages, by path and query; `null` when there is none. */
const fixturePage = (url: URL): FixturePage | null => {
  switch (url.pathname) {
    case "/":
      return {
        title: "Fixture library",
        text: "Search the fixture library.",
        elements: [
          { role: "searchbox", name: "Search" },
          { role: "button", name: "Search" },
        ],
      };
    case "/search": {
      const query = url.searchParams.get("q") ?? "";
      return {
        title: `Results for ${query}`,
        text: "Two decisions match.",
        elements: [
          { role: "link", name: DECISION.title, href: DECISION.path },
          {
            role: "link",
            name: "Decision 7 T 89/2023",
            href: "/doc/7-t-89-2023",
          },
        ],
      };
    }
    case DECISION.path:
      return {
        title: DECISION.title,
        text: `The notice period runs from delivery, not from dispatch. ${FIXTURE_CANARIES[0]} The claimant, ${FIXTURE_CANARIES[1]}, lost the appeal.`,
        elements: [
          { role: "link", name: "Back to results", href: "/" },
          { role: "textbox", name: "Note" },
        ],
      };
    case "/account":
      return { title: "Sign in", text: "", elements: [], signIn: true };
    default:
      return null;
  }
};

/** The library site, serving each page's model as JSON. */
export const startFixtureLibrary = () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const page = fixturePage(new URL(request.url));
      return page === null
        ? new Response(null, { status: 404 })
        : Response.json(page);
    },
  });
  const origin = `http://127.0.0.1:${String(server.port)}`;
  return {
    origin,
    stop: async () => {
      await server.stop(true);
    },
  };
};

const ABSENT = { type: BROWSER_CONTROL_TARGET_METADATA.absent } as const;
const TAB_ID = 41;

const errorResult = (
  code: BrowserControlErrorCode,
  message: string,
): BrowserControlResult => ({
  code,
  message,
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  status: "error",
});

/**
 * Chrome with the stella extension, as far as the native host can tell:
 * frames in on the host's standard input, frames out of its output. It
 * keeps one tab, reads pages from the fixture library and holds commands
 * to the page they name, as the extension does.
 */
export const startFakeExtension = ({
  hostCommand,
}: {
  /** How Chrome starts the native host. */
  hostCommand: readonly string[];
}) => {
  const host = Bun.spawn([...hostCommand], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const tab: {
    url: string | null;
    page: FixturePage | null;
    revision: string;
    typed: Map<string, string>;
  } = { url: null, page: null, revision: "", typed: new Map() };
  const commands: BrowserControlCommand[] = [];
  /** Settles once stella desktop's hello came through the host. */
  const connected = Promise.withResolvers<null>();

  const refOf = (index: number) => `e:0:${String(index)}`;

  const snapshot = (): BrowserControlResult => {
    const { page, url } = tab;
    if (page === null || url === null) {
      return errorResult(
        BROWSER_CONTROL_ERROR_CODE.noControlledTab,
        "No tab is open.",
      );
    }
    if (page.signIn === true) {
      return errorResult(
        BROWSER_CONTROL_ERROR_CODE.needsMember,
        "This page asks for a sign-in.",
      );
    }
    tab.revision = crypto.randomUUID();
    return {
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      snapshot: {
        contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
        elements: page.elements.map((element, index) => ({
          context: ABSENT,
          href:
            element.href === undefined
              ? ABSENT
              : {
                  type: BROWSER_CONTROL_TARGET_METADATA.present,
                  value: new URL(element.href, url).href,
                },
          name: element.name,
          ref: refOf(index),
          role: element.role,
        })),
        revision: tab.revision,
        tabId: TAB_ID,
        tabs: [],
        text: page.text,
        textOffset: 0,
        textTotalChars: page.text.length,
        title: page.title,
        url,
      },
      status: "success",
    };
  };

  const navigate = async (url: string): Promise<BrowserControlResult> => {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const page = v.parse(fixturePageSchema, await response.json());
    tab.url = url;
    tab.page = page;
    tab.typed = new Map();
    return snapshot();
  };

  const run = async (
    command: BrowserControlCommand,
  ): Promise<BrowserControlResult> => {
    commands.push(command);
    switch (command.action) {
      case "open":
        return await navigate(command.url);
      case "snapshot":
        return snapshot();
      case "click":
      case "fill": {
        if (
          command.page.revision !== tab.revision ||
          command.page.url !== tab.url
        ) {
          return errorResult(
            BROWSER_CONTROL_ERROR_CODE.staleSnapshot,
            "The page changed.",
          );
        }
        const index = Number(command.target.ref.split(":").at(2));
        const element = tab.page?.elements.at(index);
        if (element === undefined) {
          return errorResult(
            BROWSER_CONTROL_ERROR_CODE.elementNotFound,
            "No such element.",
          );
        }
        if (command.action === "fill") {
          tab.typed.set(command.target.ref, command.value);
          return snapshot();
        }
        if (element.href !== undefined) {
          return await navigate(new URL(element.href, tab.url).href);
        }
        const query = [...tab.typed.values()].at(0) ?? "";
        return await navigate(
          new URL(`/search?q=${encodeURIComponent(query)}`, tab.url).href,
        );
      }
      case "go-back":
      case "press-key":
      case "select":
      case "switch-tab":
        return errorResult(
          BROWSER_CONTROL_ERROR_CODE.executionFailed,
          "Not in the fixture.",
        );
      default:
        command satisfies never;
        return panic("Unhandled browser command");
    }
  };

  const send = (message: unknown) => {
    const frame = encodeNativeMessage(JSON.stringify(message));
    if (frame !== null) {
      Promise.resolve(host.stdin.write(frame)).catch(() => undefined);
    }
  };

  const read = nativeMessageReader((json) => {
    const request = parseBrowserDesktopRequest(JSON.parse(json));
    if (request === null) {
      return;
    }
    switch (request.type) {
      case "hello":
        send({
          protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
          source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
          type: "hello",
        });
        connected.resolve(null);
        return;
      case "command":
        run(request.command)
          .then((result) => {
            send({
              protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
              requestId: request.requestId,
              result,
              source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
              type: "command-result",
            });
            return undefined;
          })
          .catch(() => undefined);
        return;
      case "cancel":
        return;
      default:
        request satisfies never;
        panic("Unhandled desktop request");
    }
  });
  const pumped = (async () => {
    for await (const chunk of host.stdout) {
      read(chunk);
    }
  })();

  return {
    commands,
    connected: connected.promise,
    stop: async () => {
      await host.stdin.end();
      host.kill();
      await host.exited;
      await pumped;
    },
  };
};

type McpEndpoint = { url: string; token: string };

const mcpCall = async (
  endpoint: McpEndpoint,
  id: number,
  method: string,
  params: object,
): Promise<unknown> => {
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${endpoint.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ id, jsonrpc: "2.0", method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body: unknown = await response.json();
  return typeof body === "object" && body !== null
    ? Reflect.get(body, "result")
    : undefined;
};

const toolResultSchema = v.object({
  content: v.array(v.object({ type: v.literal("text"), text: v.string() })),
  isError: v.optional(v.boolean()),
});

const pageSchema = v.object({
  url: v.string(),
  title: v.string(),
  text: v.string(),
  elements: v.array(
    v.object({
      ref: v.string(),
      role: v.string(),
      name: v.string(),
      href: v.optional(v.string()),
    }),
  ),
});

/** One MCP tool call the agent made, as a harness reports it. */
type FakeAgentStep = {
  id: string;
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
  text: string;
  isError: boolean;
};

/**
 * The agent's turn: a stella search through the run's stella MCP binding,
 * then the library: open it, search, open the first result, read it, and
 * try the account page, which asks for a sign-in. It answers citing the
 * decision's title and address.
 */
const runFakeBrowserAgent = async ({
  browser,
  browserServer,
  stella,
  stellaServer,
  start,
}: {
  browser: McpEndpoint;
  browserServer: string;
  stella: McpEndpoint;
  stellaServer: string;
  start: string;
}): Promise<{
  steps: FakeAgentStep[];
  answer: string;
  /** The canaries the decision's page text held, as the agent read it. */
  read: string[];
}> => {
  const steps: FakeAgentStep[] = [];
  let requestId = 0;
  const initialized = new Set<string>();
  const call = async (
    server: string,
    endpoint: McpEndpoint,
    tool: string,
    args: Record<string, unknown>,
  ) => {
    if (!initialized.has(server)) {
      initialized.add(server);
      requestId += 1;
      await mcpCall(endpoint, requestId, "initialize", {
        capabilities: {},
        clientInfo: { name: "fake-agent", version: "0" },
        protocolVersion: "2025-06-18",
      });
    }
    requestId += 1;
    const result = v.parse(
      toolResultSchema,
      await mcpCall(endpoint, requestId, "tools/call", {
        arguments: args,
        name: tool,
      }),
    );
    const text = result.content.map((block) => block.text).join("");
    steps.push({
      id: `call-${String(requestId)}`,
      server,
      tool,
      arguments: args,
      text,
      isError: result.isError === true,
    });
    return text;
  };
  const page = (text: string) => v.parse(pageSchema, JSON.parse(text));
  const refOf = (
    elements: v.InferOutput<typeof pageSchema>["elements"],
    role: string,
    name?: string,
  ) =>
    elements.find(
      (element) =>
        element.role === role && (name === undefined || element.name === name),
    )?.ref ?? panic(`The page has no ${role} ${name ?? ""}`);

  await call(stellaServer, stella, "search_case_law", { query: FIXTURE_QUERY });
  const home = page(await call(browserServer, browser, "open", { url: start }));
  await call(browserServer, browser, "type", {
    ref: refOf(home.elements, "searchbox"),
    text: FIXTURE_QUERY,
  });
  const typed = page(await call(browserServer, browser, "snapshot", {}));
  const results = page(
    await call(browserServer, browser, "click", {
      ref: refOf(typed.elements, "button", "Search"),
    }),
  );
  const decision = page(
    await call(browserServer, browser, "click", {
      ref: refOf(results.elements, "link", DECISION.title),
    }),
  );
  // The agent read the decision, canaries and all: what follows proves they
  // went no further.
  const read = FIXTURE_CANARIES.filter((canary) =>
    decision.text.includes(canary),
  );
  // Not a search field: the member is asked first.
  await call(browserServer, browser, "type", {
    ref: refOf(decision.elements, "textbox", "Note"),
    text: "Check the notice period",
  });
  await call(browserServer, browser, "open", {
    url: new URL("/account", start).href,
  });
  return {
    read,
    steps,
    answer: `The notice period runs from delivery, as held in [${decision.title}](${decision.url}).`,
  };
};

/** The decision the agent cites, for the test to look for in the answer. */
export const FIXTURE_CITATION = DECISION;

const bearerSchema = v.pipe(
  v.string(),
  v.regex(/^Bearer \S+$/u),
  v.transform((header) => header.slice("Bearer ".length)),
);

const codexServerSchema = v.object({
  url: v.string(),
  http_headers: v.object({ Authorization: bearerSchema }),
});

const claudeServerSchema = v.object({
  url: v.string(),
  headers: v.object({ Authorization: bearerSchema }),
});

/** The MCP servers a Codex `thread/start` configured, by name. */
export const codexMcpEndpoints = (
  params: unknown,
): Map<string, McpEndpoint> => {
  const config: unknown =
    typeof params === "object" && params !== null
      ? Reflect.get(params, "config")
      : undefined;
  const endpoints = new Map<string, McpEndpoint>();
  if (typeof config !== "object" || config === null) {
    return endpoints;
  }
  for (const [key, value] of Object.entries(config)) {
    const server = v.safeParse(codexServerSchema, value);
    if (key.startsWith("mcp_servers.") && server.success) {
      endpoints.set(key.slice("mcp_servers.".length), {
        token: server.output.http_headers.Authorization,
        url: server.output.url,
      });
    }
  }
  return endpoints;
};

/** The MCP servers a Claude Code `mcp_set_servers` registered, by name. */
export const claudeMcpEndpoints = (
  servers: unknown,
): Map<string, McpEndpoint> =>
  new Map(
    Object.entries(
      typeof servers === "object" && servers !== null ? servers : {},
    ).flatMap(([name, value]) => {
      const server = v.safeParse(claudeServerSchema, value);
      return server.success
        ? [
            [
              name,
              {
                token: server.output.headers.Authorization,
                url: server.output.url,
              },
            ] as const,
          ]
        : [];
    }),
  );

/**
 * The agent's turn against the servers a harness registered, starting at
 * `FAKE_BROWSER_START`.
 */
export const browseAsAgent = async ({
  browserServer,
  endpoints,
  stellaServer,
}: {
  browserServer: string;
  endpoints: ReadonlyMap<string, McpEndpoint>;
  stellaServer: string;
}) =>
  await runFakeBrowserAgent({
    browser:
      endpoints.get(browserServer) ?? panic("No browser server registered"),
    browserServer,
    stella: endpoints.get(stellaServer) ?? panic("No stella server registered"),
    stellaServer,
    start:
      process.env["FAKE_BROWSER_START"] ?? panic("FAKE_BROWSER_START is unset"),
  });
