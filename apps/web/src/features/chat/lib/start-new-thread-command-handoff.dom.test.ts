import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { EventType } from "@tanstack/ai";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { ChatLocalRunTarget } from "@stll/api-contract/chat-run-target";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import type { WebApiRoutes } from "@/lib/api";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });
const previousFetch = globalThis.fetch;

const { waitFor } = await import("@testing-library/react");
const { QueryClient } = await import("@tanstack/react-query");
const { __resetChatRequestStateForTests } =
  await import("@/features/chat/chat-runtime-registry");
const { createChatThreadId } = await import("@/lib/chat-thread-ref");
const { startNewThreadCommandHandoff } =
  await import("./start-new-thread-command-handoff");

const ORGANIZATION_ID = "00000000-0000-7000-8000-00000000ffff";

const CODEX: ChatLocalRunTarget = {
  kind: "local",
  harness: "codex",
  model: "gpt-5-codex",
  approvals: "ask",
};

type ThreadResponse =
  WebApiRoutes["chat"]["threads"][":threadId"]["messages"]["get"]["response"][200];

const NEW_THREAD: ThreadResponse = {
  activeSkill: null,
  activeTurnId: null,
  newestLocalTurn: null,
  attachedFiles: { fileCount: 0, files: [] },
  context: {
    estimatedTokens: 0,
    triggerTokens: 0,
    cacheStableTokens: 0,
    summarizedMessageCount: 0,
    breakdown: {
      promptTokens: 0,
      toolTokens: 0,
      summaryTokens: 0,
      attachmentTokens: 0,
      conversationTokens: 0,
    },
  },
  contextMatterIds: [],
  forkProvenance: { type: "none" },
  lastActivityAt: null,
  messages: [],
  model: null,
  olderCursor: null,
  reasoningEffort: null,
  threadExists: false,
  threadRevision: "2026-10-10T12:00:00.000Z",
  usedAnonymization: false,
  webSearchAvailable: false,
  webSearchEnabled: false,
};

/** The server: a thread nobody wrote to yet, and a send that answers once. */
const serve = () => {
  const sends: unknown[] = [];
  const unexpected: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      if (/\/chat\/threads\/[^/]+\/messages$/u.test(pathname)) {
        return Response.json(NEW_THREAD);
      }
      if (pathname.endsWith("/chat") && request.method === "POST") {
        const body: unknown = await request.json();
        sends.push(body);
        const runId =
          typeof body === "object" &&
          body !== null &&
          "runId" in body &&
          typeof body.runId === "string"
            ? body.runId
            : "run";
        const at = 1_791_633_600_000;
        const events = [
          {
            type: EventType.RUN_STARTED,
            runId,
            threadId: "thread",
            timestamp: at,
          },
          {
            type: EventType.RUN_FINISHED,
            runId,
            threadId: "thread",
            timestamp: at,
            finishReason: "stop",
          },
        ];
        return new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      unexpected.push(`${request.method} ${pathname}`);
      return Response.json(
        { message: `Unexpected request: ${pathname}` },
        { status: 500 },
      );
    },
    { preconnect: previousFetch.preconnect },
  );
  return { sends, unexpected };
};

const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(() => {
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  __resetChatRequestStateForTests();
  globalThis.fetch = previousFetch;
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

/** `/new <message>` from a composer whose turns run on `runTarget`. */
const startNewThread = async (
  getRunTarget: (() => ChatLocalRunTarget) | undefined,
) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(queryClient);
  const threadId = createChatThreadId();
  const result = await startNewThreadCommandHandoff({
    activeOrganizationId: ORGANIZATION_ID,
    context: {
      allowMissingThread: true,
      getContextMatterIds: () => [],
      getRunTarget,
    },
    files: [],
    html: "<p>Run the tests</p>",
    queryClient,
    threadRef: { scope: "global", threadId },
  });
  return { result, threadId };
};

test("a new thread started from a chat on the member's computer sends its first turn there", async () => {
  const server = serve();
  const { result, threadId } = await startNewThread(() => CODEX);

  expect(result.isOk()).toBe(true);
  await waitFor(() => expect(server.sends).toHaveLength(1));
  expect(server.sends.at(0)).toMatchObject({
    threadId,
    forwardedProps: { runTarget: CODEX },
  });
  expect(server.unexpected).toEqual([]);
});

test("a new thread started from a chat on stella sends no run target", async () => {
  const server = serve();
  const { result } = await startNewThread(undefined);

  expect(result.isOk()).toBe(true);
  await waitFor(() => expect(server.sends).toHaveLength(1));
  expect(server.sends.at(0)).not.toMatchObject({
    forwardedProps: { runTarget: expect.anything() },
  });
  expect(server.unexpected).toEqual([]);
});
