import type { PropsWithChildren } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic, Result } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import { toChatThreadId } from "@/lib/chat-thread-ref";
import type { WebApiRoutes } from "@/lib/eden-client";

import type {
  PersistedChatModelSelection,
  UseChatModelSelectionOptions,
} from "./use-chat-model-selection";

GlobalRegistrator.register({ url: "https://app.example.test/chat" });
const previousApiUrl = process.env["VITE_API_URL"];
process.env["VITE_API_URL"] ??= "https://api.example.test";
const { act, cleanup, renderHook, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { useChatModelSelection } = await import("./use-chat-model-selection");
const { apiUrl } = await import("@/lib/api-url");
const messages = (await import("@/i18n/langs/en.json")).default;
const previousFetch = globalThis.fetch;
const pendingResponses: ReturnType<typeof Promise.withResolvers<Response>>[] =
  [];
const selection = {
  model: "openai::synthetic-model",
  reasoningEffort: "high",
} as const satisfies WebApiRoutes["chat"]["threads"][":threadId"]["model"]["patch"]["response"][200];
const threadRef = {
  scope: "workspace",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  threadId: toChatThreadId("00000000-0000-4000-8000-000000000001"),
} as const;
const wrapper = ({ children }: PropsWithChildren) => (
  <IntlProvider locale="en" messages={messages} timeZone="UTC">
    {children}
  </IntlProvider>
);

const deferredResponse = () => {
  const pending = Promise.withResolvers<Response>();
  pendingResponses.push(pending);
  return pending;
};
const installTransport = (reply: (request: Request) => Promise<Response>) => {
  const requests: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      expect(request.method).toBe("PATCH");
      expect(new URL(request.url).pathname).toBe(
        new URL(apiUrl(`/chat/threads/${threadRef.threadId}/model`)).pathname,
      );
      return await reply(request);
    },
    { preconnect: previousFetch.preconnect },
  );
  return requests;
};
afterEach(async () => {
  await act(async () => {
    for (const pending of pendingResponses) {
      pending.resolve(Response.json(selection));
    }
    pendingResponses.length = 0;
    await Promise.resolve();
    cleanup();
  });
  globalThis.fetch = previousFetch;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
  if (previousApiUrl === undefined) {
    delete process.env["VITE_API_URL"];
  } else {
    process.env["VITE_API_URL"] = previousApiUrl;
  }
});

for (const threadExists of [false, true]) {
  test(`a carried selection PATCH begins before the first send gate for row-exists ${threadExists}`, async () => {
    const response = deferredResponse();
    const requests = installTransport(async () => await response.promise);
    const persisted: PersistedChatModelSelection[] = [];
    const props = {
      threadRef,
      draftSelection: {
        ...selection,
        threadExists,
        modelSelectionSource: "carried",
      },
      onPersisted: (value: PersistedChatModelSelection) => {
        persisted.push(value);
      },
    } satisfies UseChatModelSelectionOptions;
    const hook = renderHook(useChatModelSelection, {
      initialProps: props,
      wrapper,
    });
    // The mounted carried selection starts persistence before the send path asks for its gate.
    await waitFor(() => expect(requests).toHaveLength(1));
    const request = requests.at(0);
    if (request === undefined) {
      panic("The carried model selection did not issue its PATCH");
    }
    expect(await request.json()).toEqual(selection);
    expect(new URL(request.url).searchParams.get("workspaceId")).toBe(
      threadRef.workspaceId,
    );
    let admitted = false;
    const gate = hook.result.current.awaitPendingSelection().then((result) => {
      admitted = Result.isOk(result);
      return result;
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(admitted).toBe(false);
    expect(persisted).toEqual([]);
    await act(async () => {
      response.resolve(Response.json(selection));
      await gate;
    });
    expect(admitted).toBe(true);
    expect(persisted).toEqual([selection]);
    expect(Result.isOk(await hook.result.current.awaitPendingSelection())).toBe(
      true,
    );
    expect(requests).toHaveLength(1);
  });
}

test("failed carried persistence keeps later sends refused until the user retries the model", async () => {
  let attempts = 0;
  const retry = deferredResponse();
  const requests = installTransport(async () => {
    attempts += 1;
    return attempts === 1
      ? Response.json(
          { message: "Synthetic persistence unavailable" },
          { status: 503 },
        )
      : await retry.promise;
  });
  const persisted: PersistedChatModelSelection[] = [];
  const props = {
    threadRef,
    draftSelection: {
      ...selection,
      threadExists: false,
      modelSelectionSource: "carried",
    },
    onPersisted: (value: PersistedChatModelSelection) => {
      persisted.push(value);
    },
  } satisfies UseChatModelSelectionOptions;
  const hook = renderHook(useChatModelSelection, {
    initialProps: props,
    wrapper,
  });
  await waitFor(() => expect(requests).toHaveLength(1));
  await act(async () => {
    expect(
      Result.isError(await hook.result.current.awaitPendingSelection()),
    ).toBe(true);
  });
  expect(
    Result.isError(await hook.result.current.awaitPendingSelection()),
  ).toBe(true);
  expect(requests).toHaveLength(1);
  expect(persisted).toEqual([]);
  act(() => {
    hook.result.current.selectModel(selection);
  });
  await waitFor(() => expect(requests).toHaveLength(2));
  const gate = hook.result.current.awaitPendingSelection();
  await act(async () => {
    retry.resolve(Response.json(selection));
    await gate;
  });
  expect(Result.isOk(await hook.result.current.awaitPendingSelection())).toBe(
    true,
  );
  expect(persisted).toEqual([selection]);
  expect(requests).toHaveLength(2);
});

const OLD_THREAD_OUTCOMES = {
  success: () => Response.json(selection),
  failure: () =>
    Response.json(
      { message: "Old-thread persistence unavailable" },
      { status: 503 },
    ),
};

for (const [outcome, reply] of Object.entries(OLD_THREAD_OUTCOMES)) {
  test(`an old thread's late ${outcome} cannot block or update the next thread's default model`, async () => {
    const response = deferredResponse();
    const requests = installTransport(async () => await response.promise);
    const persisted: PersistedChatModelSelection[] = [];
    const onPersisted = (value: PersistedChatModelSelection) => {
      persisted.push(value);
    };
    const props: UseChatModelSelectionOptions = {
      threadRef,
      draftSelection: {
        ...selection,
        threadExists: false,
        modelSelectionSource: "carried",
      },
      onPersisted,
    };
    const hook = renderHook(useChatModelSelection, {
      initialProps: props,
      wrapper,
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    const oldGate = hook.result.current.awaitPendingSelection();
    const nextRef = {
      scope: "global",
      threadId: toChatThreadId("00000000-0000-4000-8000-000000000003"),
    } as const;
    hook.rerender({
      threadRef: nextRef,
      draftSelection: {
        model: null,
        reasoningEffort: null,
        threadExists: false,
        modelSelectionSource: "carried",
      },
      onPersisted,
    });
    expect(Result.isOk(await hook.result.current.awaitPendingSelection())).toBe(
      true,
    );
    expect(requests).toHaveLength(1);
    await act(async () => {
      response.resolve(reply());
      await oldGate;
    });
    expect(Result.isOk(await hook.result.current.awaitPendingSelection())).toBe(
      true,
    );
    expect(requests).toHaveLength(1);
    expect(persisted).toEqual([]);
  });
}
