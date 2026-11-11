import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";
import * as v from "valibot";

import {
  type ChatLocalRunTarget,
  chatRunTargetSchema,
} from "@stll/api-contract/chat-run-target";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });
const previousFetch = globalThis.fetch;

const { act, cleanup, renderHook, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider, queryOptions } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { toChatThreadId } = await import("@/lib/chat-thread-ref");
const { useChatComposerModels } = await import("./use-chat-composer-models");

afterEach(() => {
  cleanup();
  globalThis.fetch = previousFetch;
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
const serve = () => {
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

/** The composer over a thread that runs on stella with Auto. */
const renderComposer = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const stored = queryOptions({
    queryKey: ["composer-models-test", threadRef.threadId],
    queryFn: () => ({
      model: null as string | null,
      reasoningEffort: null,
      runTarget: undefined as ChatLocalRunTarget | undefined,
    }),
  });
  queryClient.setQueryData(stored.queryKey, {
    model: null,
    reasoningEffort: null,
    runTarget: undefined,
  });
  return renderHook(
    () =>
      useChatComposerModels({
        activeOrganizationId: ORGANIZATION_ID,
        threadRef,
        stored: queryClient.getQueryData(stored.queryKey),
        queryKey: stored.queryKey,
      }),
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
};

test("a send right after choosing the computer carries it, once the choice is stored", async () => {
  const server = serve();
  const { result } = renderComposer();
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
  const { result } = renderComposer();
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
    { model: CLOUD_MODEL, reasoningEffort: null },
    { model: CLOUD_MODEL, reasoningEffort: null, runTarget: CODEX },
  ]);
});
