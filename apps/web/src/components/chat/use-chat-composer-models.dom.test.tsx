import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import * as v from "valibot";

import type { ReasoningEffort } from "@stll/ai-catalog";
import {
  type ChatLocalRunReadiness,
  type ChatLocalRunTarget,
  type ChatRunTarget,
  chatRunTargetSchema,
} from "@stll/api-contract/chat-run-target";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });
const previousFetch = globalThis.fetch;

const { act, cleanup, renderHook, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider, queryOptions, useQuery } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { toChatThreadId } = await import("@/lib/chat-thread-ref");
const { rememberRunTarget, useChatRunOnPreferenceStore } =
  await import("@/features/chat/run-on-preference-store");
const { localRunnersOptions } = await import("@/features/chat/queries");
const { useChatComposerModels } = await import("./use-chat-composer-models");
const desktopBridge = await import("@/lib/desktop-bridge");
const { getDesktopLaunch } = await import("@/features/chat/desktop-launch");
const { DESKTOP_PING_URL } =
  await import("@/features/chat/desktop-launch.logic");

afterEach(() => {
  cleanup();
  useChatRunOnPreferenceStore.setState({ byOrganization: {} });
  globalThis.fetch = previousFetch;
  mock.restore();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const ORGANIZATION_ID = "00000000-0000-7000-8000-00000000ffff";
const threadRef = {
  scope: "global",
  threadId: toChatThreadId("00000000-0000-7000-8000-00000000c0de"),
} as const;

const CODEX: ChatLocalRunTarget = {
  kind: "local",
  harness: "codex",
  model: "gpt-5-codex",
  approvals: "ask",
  reasoningEffort: null,
};
const CLOUD_MODEL = "openai::gpt-5";

const patchBodySchema = v.object({
  model: v.nullable(v.string()),
  reasoningEffort: v.nullable(v.string()),
  runTarget: v.optional(chatRunTargetSchema),
});

/**
 * The server: each model PATCH is held until the test releases it, so a test
 * can act while a write is still in flight.
 */
const serve = ({
  computers,
}: {
  /** The member's computers as the API reads them now; unread otherwise. */
  computers?: () => ChatLocalRunReadiness;
} = {}) => {
  const patches: v.InferOutput<typeof patchBodySchema>[] = [];
  const held: PromiseWithResolvers<undefined>[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      if (pathname.endsWith("/model") && request.method === "PATCH") {
        const body = v.parse(patchBodySchema, await request.json());
        patches.push(body);
        const release = Promise.withResolvers<undefined>();
        held.push(release);
        await release.promise;
        return Response.json(body);
      }
      if (pathname.endsWith("/chat/local-runners") && computers) {
        return Response.json(computers());
      }
      return Response.json(
        { message: `Unexpected request: ${pathname}` },
        { status: 500 },
      );
    },
    { preconnect: previousFetch.preconnect },
  );
  /** Release the oldest held write once it has arrived. */
  const releaseNext = async () => {
    await waitFor(() => expect(held.length).toBeGreaterThan(0));
    held.shift()?.resolve(undefined);
  };
  return { patches, releaseNext };
};

/** What a thread stores about its turns, as the composer reads it. */
type StoredChoice = {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  runTarget?: ChatRunTarget;
  threadExists: boolean;
};

/** A thread that runs on stella with Auto. */
const AUTO_ON_STELLA: StoredChoice = {
  model: null,
  reasoningEffort: null,
  threadExists: true,
};

/** A new chat the server holds no row for yet. */
const NEW_CHAT: StoredChoice = { ...AUTO_ON_STELLA, threadExists: false };

/** Each composer's first read of its stored choice, by the id in its key. */
const storedReads = new Map<string, Promise<StoredChoice>>();

/** The composer over a thread whose stored choice the query reads. */
const renderComposer = (
  initial: Promise<StoredChoice> = Promise.resolve(AUTO_ON_STELLA),
  { startsOnLastChoice = false }: { startsOnLastChoice?: boolean } = {},
) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const readId = Bun.randomUUIDv7();
  storedReads.set(readId, initial);
  const stored = queryOptions({
    queryKey: ["composer-models-test", threadRef.threadId, readId] as const,
    queryFn: async ({ queryKey }): Promise<StoredChoice> =>
      await (storedReads.get(queryKey[2]) ?? Promise.resolve(AUTO_ON_STELLA)),
  });
  const view = renderHook(
    () => {
      const { data } = useQuery(stored);
      return useChatComposerModels({
        activeOrganizationId: ORGANIZATION_ID,
        threadRef,
        stored: data,
        queryKey: stored.queryKey,
        startsOnLastChoice,
      });
    },
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          <IntlProvider locale="en" messages={messages} timeZone="UTC">
            {children}
          </IntlProvider>
        </QueryClientProvider>
      ),
    },
  );
  return Object.assign(view, { queryClient, queryKey: stored.queryKey });
};

/** A new chat's composer, on a surface that opens new chats. */
const renderNewChat = () =>
  renderComposer(Promise.resolve(NEW_CHAT), { startsOnLastChoice: true });

/** The composer once its stored choice is read. */
const renderReadyComposer = async () => {
  const view = renderComposer();
  await waitFor(() => expect(view.result.current.models.state).toBe("ready"));
  return view;
};

test("the menus stay disabled, and nothing is written, until the stored choice is read", async () => {
  const server = serve();
  const read = Promise.withResolvers<StoredChoice>();
  const { result } = renderComposer(read.promise);
  expect(result.current.models.state).toBe("loading");
  act(() => {
    result.current.models.selectModel({
      model: CLOUD_MODEL,
      reasoningEffort: null,
    });
  });
  expect(server.patches).toEqual([]);

  read.resolve({
    model: CLOUD_MODEL,
    reasoningEffort: null,
    threadExists: true,
  });
  await waitFor(() => expect(result.current.models.state).toBe("ready"));
  expect(result.current.models.selectedModel).toBe(CLOUD_MODEL);
});

test("a send right after choosing the computer carries it, once the choice is stored", async () => {
  const server = serve();
  const { result } = await renderReadyComposer();
  const { models, awaitPendingSelection, getRunTarget } = result.current;
  const runOn = models.runTarget;
  if (runOn.type !== "choice") {
    throw new Error("The composer offers no Run on choice");
  }

  act(() => {
    runOn.select(CODEX);
  });
  // The send waits for the write, then reads the target with no render in
  // between, as a send started while the write is in flight does.
  const sent = (async () => {
    (await awaitPendingSelection()).unwrap();
    return getRunTarget();
  })();
  await server.releaseNext();

  expect(await sent).toEqual(CODEX);
});

test("a model chosen just before the computer is kept by the write that follows", async () => {
  const server = serve();
  const { result } = await renderReadyComposer();
  const { models, awaitPendingSelection } = result.current;
  const runOn = models.runTarget;
  if (runOn.type !== "choice") {
    throw new Error("The composer offers no Run on choice");
  }

  act(() => {
    models.selectModel({ model: CLOUD_MODEL, reasoningEffort: null });
    runOn.select(CODEX);
  });
  await server.releaseNext();
  await server.releaseNext();
  (await awaitPendingSelection()).unwrap();

  expect(server.patches).toEqual([
    { model: CLOUD_MODEL, reasoningEffort: null, runTarget: { kind: "cloud" } },
    { model: CLOUD_MODEL, reasoningEffort: null, runTarget: CODEX },
  ]);
});

test("a menu opened while the computer is being written shows the computer", async () => {
  const server = serve();
  const { result } = await renderReadyComposer();
  const runOn = result.current.models.runTarget;
  if (runOn.type !== "choice") {
    throw new Error("The composer offers no Run on choice");
  }
  act(() => {
    runOn.select(CODEX);
  });
  // The write is still held: what a menu opened now reads.
  const pending = result.current.models.runTarget;
  expect(pending.type === "choice" && pending.selected).toEqual(CODEX);
  await server.releaseNext();
  (await result.current.awaitPendingSelection()).unwrap();
});

test("a new chat starts on the member's last Run on choice, and a send carries it", async () => {
  const server = serve();
  rememberRunTarget(ORGANIZATION_ID, CODEX);
  const { result } = renderNewChat();
  await waitFor(() => expect(result.current.models.state).toBe("ready"));

  expect(result.current.runTarget).toEqual(CODEX);
  (await result.current.awaitPendingSelection()).unwrap();
  expect(result.current.getRunTarget()).toEqual(CODEX);
  // Nothing is written to start there: the first send carries the target.
  expect(server.patches).toEqual([]);
});

test("a model picked on a new chat stores the remembered target with it, and the chat keeps it", async () => {
  const server = serve();
  rememberRunTarget(ORGANIZATION_ID, CODEX);
  const { result } = renderNewChat();
  await waitFor(() => expect(result.current.models.state).toBe("ready"));

  act(() => {
    result.current.models.selectModel({
      model: CLOUD_MODEL,
      reasoningEffort: null,
    });
  });
  await server.releaseNext();
  (await result.current.awaitPendingSelection()).unwrap();
  // Another chat changes the member's last choice; this one keeps its own.
  act(() => {
    rememberRunTarget(ORGANIZATION_ID, { kind: "cloud" });
  });

  expect(server.patches).toEqual([
    { model: CLOUD_MODEL, reasoningEffort: null, runTarget: CODEX },
  ]);
  expect(result.current.runTarget).toEqual(CODEX);
  expect(result.current.getRunTarget()).toEqual(CODEX);
});

test("a chat the server holds runs where it stored, whatever the member chose last", async () => {
  serve();
  rememberRunTarget(ORGANIZATION_ID, CODEX);
  const { result } = renderComposer(Promise.resolve(AUTO_ON_STELLA), {
    startsOnLastChoice: true,
  });
  await waitFor(() => expect(result.current.models.state).toBe("ready"));

  expect(result.current.runTarget).toEqual({ kind: "cloud" });
  expect(result.current.getRunTarget()).toEqual({ kind: "cloud" });
});

test("a Run on pick is remembered as the member's last choice", async () => {
  const server = serve();
  const { result } = await renderReadyComposer();
  const runOn = result.current.models.runTarget;
  if (runOn.type !== "choice") {
    throw new Error("The composer offers no Run on choice");
  }
  act(() => {
    runOn.select(CODEX);
  });
  await server.releaseNext();
  (await result.current.awaitPendingSelection()).unwrap();

  // Where it runs and on which model; the permission stays with the chat.
  expect(
    useChatRunOnPreferenceStore.getState().byOrganization[ORGANIZATION_ID],
  ).toEqual({ kind: "local", harness: "codex", model: CODEX.model });
});

const FULL_AUTO: ChatLocalRunTarget = { ...CODEX, approvals: "full_auto" };

test("a new chat starts on the remembered computer with Ask, never a permission granted before", async () => {
  serve();
  rememberRunTarget(ORGANIZATION_ID, FULL_AUTO);
  const { result } = renderNewChat();
  await waitFor(() => expect(result.current.models.state).toBe("ready"));

  expect(result.current.runTarget).toEqual(CODEX);
  expect(result.current.getRunTarget()).toEqual(CODEX);
});

test("full auto picked in one chat does not reach the start of another", async () => {
  const server = serve();
  const first = await renderReadyComposer();
  const runOn = first.result.current.models.runTarget;
  if (runOn.type !== "choice") {
    throw new Error("The composer offers no Run on choice");
  }
  act(() => {
    runOn.select(FULL_AUTO);
  });
  await server.releaseNext();
  (await first.result.current.awaitPendingSelection()).unwrap();
  expect(first.result.current.getRunTarget()).toEqual(FULL_AUTO);

  const next = renderNewChat();
  await waitFor(() => expect(next.result.current.models.state).toBe("ready"));
  expect(next.result.current.getRunTarget()).toEqual(CODEX);
});

test("a new chat keeps its start when another write creates its row", async () => {
  serve();
  rememberRunTarget(ORGANIZATION_ID, CODEX);
  const { result, queryClient, queryKey } = renderNewChat();
  await waitFor(() => expect(result.current.models.state).toBe("ready"));

  // Web search turned on creates the row; it reads back with no run target.
  act(() => {
    queryClient.setQueryData(queryKey, { ...AUTO_ON_STELLA });
  });

  expect(result.current.runTarget).toEqual(CODEX);
  expect(result.current.getRunTarget()).toEqual(CODEX);
});

test("a thread page shows what its thread stores, whatever the member chose last", async () => {
  serve();
  rememberRunTarget(ORGANIZATION_ID, CODEX);
  const { result } = renderComposer(Promise.resolve(NEW_CHAT));
  await waitFor(() => expect(result.current.models.state).toBe("ready"));

  expect(result.current.getRunTarget()).toEqual({ kind: "cloud" });
});

/**
 * The member's one computer, connected only once stella desktop was opened:
 * opening it is what connects it, as on a real machine.
 */
const computerConnectingOnOpen = () => {
  const computer = (connected: boolean): ChatLocalRunReadiness => ({
    status: "enabled",
    runners: [
      {
        desktopId: "0192f3a0-6b1c-7d2e-8f30-000000000001",
        connected,
        lastSeenAt: "2026-11-12T10:00:00.000Z",
        harnesses: [],
      },
    ],
    maxApprovals: "full_auto",
  });
  let opened = false;
  const open = spyOn(desktopBridge, "openDesktopUrl").mockImplementation(() => {
    opened = true;
  });
  return { open, computers: () => computer(opened) };
};

test("a new chat on the remembered computer opens nothing by itself; its send opens stella desktop once", async () => {
  const desktop = computerConnectingOnOpen();
  serve({ computers: desktop.computers });
  rememberRunTarget(ORGANIZATION_ID, CODEX);
  const { result, queryClient } = renderNewChat();
  await waitFor(() => expect(result.current.models.state).toBe("ready"));
  // The composer read the computers for the remembered target: offline.
  await waitFor(() =>
    expect(
      queryClient.getQueryData(localRunnersOptions(ORGANIZATION_ID).queryKey),
    ).toBeDefined(),
  );
  expect(desktop.open).not.toHaveBeenCalled();

  act(() => {
    result.current.openDesktopForSend();
  });

  expect(desktop.open).toHaveBeenCalledTimes(1);
  expect(desktop.open).toHaveBeenCalledWith(DESKTOP_PING_URL);
  expect(await getDesktopLaunch().pending()).toBe("connected");
  expect(desktop.open).toHaveBeenCalledTimes(1);
});

test("a send on stella, or on a computer that is connected, opens nothing", async () => {
  const desktop = computerConnectingOnOpen();
  serve({ computers: desktop.computers });
  const { result } = await renderReadyComposer();

  act(() => {
    result.current.openDesktopForSend();
  });

  expect(desktop.open).not.toHaveBeenCalled();
});

test("choosing the computer while none is connected opens stella desktop on that pick, once", async () => {
  const desktop = computerConnectingOnOpen();
  const server = serve({ computers: desktop.computers });
  const { result, queryClient } = await renderReadyComposer();
  await queryClient.fetchQuery(localRunnersOptions(ORGANIZATION_ID));
  const runOn = result.current.models.runTarget;
  if (runOn.type !== "choice") {
    throw new Error("The composer offers no Run on choice");
  }

  act(() => {
    runOn.select(CODEX);
  });

  expect(desktop.open).toHaveBeenCalledTimes(1);
  expect(desktop.open).toHaveBeenCalledWith(DESKTOP_PING_URL);
  await server.releaseNext();
  expect(await getDesktopLaunch().pending()).toBe("connected");
  expect(desktop.open).toHaveBeenCalledTimes(1);
});
