import type { UIMessage } from "@tanstack/ai-client";
import { panic } from "better-result";

import { ASK_USER_TOOL_NAME } from "@/api/handlers/chat/tools/native-chat-tool-names";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// The browser side of a chat thread is the web app's own code, loaded from
// `apps/web`: `createChatRuntime` (TanStack's `ChatClient` over its SSE
// adapter, with the web app's request body, native interrupt resolution,
// rejected-continuation rollback and stop) and the page load's
// `sanitizeRunningToolCalls`. Nothing here re-implements them.
//
// The web modules resolve their own `@/` imports through `apps/web`'s
// tsconfig, which only the runtime honours, so they are imported by URL and
// their surface is checked at load. A rename in the web app fails here, at
// load, instead of silently driving something else.

const WEB_CHAT_RUNTIME_URL = new URL(
  "../../../../web/src/features/chat/chat-runtime.ts",
  import.meta.url,
).href;
const WEB_CHAT_UI_TOOLS_URL = new URL(
  "../../../../web/src/components/chat/chat-ui-tools.ts",
  import.meta.url,
).href;

/** The web app's API origin in tests (`apps/web/src/test-setup.ts`). */
const WEB_TEST_API_URL = "http://localhost:3001";

type WebChatSnapshot = {
  error: Error | undefined;
  isLoading: boolean;
  messages: UIMessage[];
  status: string;
};

type WebChatRuntime = {
  addToolResult: (result: {
    output: unknown;
    tool: string;
    toolCallId: string;
  }) => Promise<void>;
  getSnapshot: () => WebChatSnapshot;
  reload: () => Promise<void>;
  resolveToolApproval: (response: {
    approved: boolean;
    id: string;
  }) => Promise<void>;
  stop: () => void;
};

type WebChatModules = {
  createChatRuntime: (props: {
    context: undefined;
    initialMessages: UIMessage[];
    key: { scope: "global"; threadId: string };
    onError: (error: Error) => void;
    onFinish: () => void;
  }) => WebChatRuntime;
  resetChatRequestStateForTests: () => void;
  sanitizeRunningToolCalls: (
    messages: readonly UIMessage[],
    mode: "hydrate",
  ) => UIMessage[];
  sendThreadChatMessage: (
    runtime: WebChatRuntime,
    message: { content: string; id: string },
  ) => Promise<void>;
};

const hasFunction = <TName extends string>(
  value: unknown,
  name: TName,
): value is Record<TName, (...args: never[]) => unknown> =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, name) === "function";

let loadedWebChat: WebChatModules | undefined;

/** The web app's chat modules, loaded once per process. */
export const loadWebChat = async (): Promise<WebChatModules> => {
  if (loadedWebChat !== undefined) {
    return loadedWebChat;
  }
  process.env["VITE_API_URL"] ??= WEB_TEST_API_URL;
  const runtime: unknown = await import(WEB_CHAT_RUNTIME_URL);
  const uiTools: unknown = await import(WEB_CHAT_UI_TOOLS_URL);
  if (
    !hasFunction(runtime, "createChatRuntime") ||
    !hasFunction(runtime, "sendThreadChatMessage") ||
    !hasFunction(runtime, "resetChatRequestStateForTests") ||
    !hasFunction(uiTools, "sanitizeRunningToolCalls")
  ) {
    return panic("The web chat modules no longer export the chat runtime");
  }
  // The functions exist (checked above); their signatures are the web app's,
  // which this file states once in `WebChatModules`.
  loadedWebChat = asTestRaw<WebChatModules>({
    createChatRuntime: runtime.createChatRuntime,
    resetChatRequestStateForTests: runtime.resetChatRequestStateForTests,
    sanitizeRunningToolCalls: uiTools.sanitizeRunningToolCalls,
    sendThreadChatMessage: runtime.sendThreadChatMessage,
  });
  return loadedWebChat;
};

/** One card the user can act on in the live view. */
type LiveCard =
  | {
      approvalId: string;
      kind: "approval";
      toolCallId: string;
      toolName: string;
    }
  | { kind: "answer"; toolCallId: string; toolName: string };

/** The cards `messages` renders for the user to act on, in display order. */
const cardsOf = (messages: readonly UIMessage[]): LiveCard[] =>
  messages.flatMap(({ parts }) =>
    parts.flatMap((part): LiveCard[] => {
      if (part.type !== "tool-call") {
        return [];
      }
      if (
        part.state === "approval-requested" &&
        part.approval !== undefined &&
        part.approval.approved === undefined
      ) {
        return [
          {
            approvalId: part.approval.id,
            kind: "approval",
            toolCallId: part.id,
            toolName: part.name,
          },
        ];
      }
      // The web app's only user-input card (`USER_INPUT_TOOL_NAMES`); other
      // open calls render as running tools, not as cards.
      return part.name === ASK_USER_TOOL_NAME &&
        part.state === "input-complete" &&
        part.output === undefined
        ? [{ kind: "answer", toolCallId: part.id, toolName: part.name }]
        : [];
    }),
  );

const MAX_SETTLE_TICKS = 20_000;
const QUIET_TICKS = 3;

const nextTick = async () =>
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

export type WebChatClient = {
  /** The approval card's Allow or Deny. */
  approve: (toolCallId: string, approved: boolean) => Promise<void>;
  /** The ask-user card's submit. */
  answer: (toolCallId: string, output: unknown) => Promise<void>;
  cards: () => LiveCard[];
  dispose: () => void;
  messages: () => UIMessage[];
  /** Retry on the latest answer (the web app's resend). */
  resend: () => Promise<void>;
  sendUserMessage: (id: string, text: string) => Promise<void>;
  /** Errors the runtime reported since the last call, cleared on read. */
  takeErrors: () => Error[];
};

/**
 * A browser tab on `threadId`: the web runtime seeded with `initialMessages`,
 * as a page load seeds it. `inFlight` reports the harness's open requests, so
 * a step returns only once the runtime and the server are both idle.
 */
export const createWebChatClient = async ({
  inFlight,
  initialMessages,
  threadId,
}: {
  inFlight: () => number;
  initialMessages: readonly UIMessage[];
  threadId: string;
}): Promise<WebChatClient> => {
  const web = await loadWebChat();
  const errors: Error[] = [];
  let disposed = false;
  const runtime = web.createChatRuntime({
    context: undefined,
    initialMessages: [...initialMessages],
    key: { scope: "global", threadId },
    onError: (error) => {
      errors.push(error);
    },
    onFinish: () => undefined,
  });

  /** Waits until no request is open and the runtime is idle. */
  const settle = async () => {
    let quiet = 0;
    for (let tick = 0; tick < MAX_SETTLE_TICKS; tick += 1) {
      await nextTick();
      const { isLoading, status } = runtime.getSnapshot();
      const busy =
        inFlight() > 0 ||
        isLoading ||
        status === "submitted" ||
        status === "streaming";
      quiet = busy ? 0 : quiet + 1;
      if (quiet >= QUIET_TICKS) {
        return;
      }
    }
    panic("The web chat runtime never settled");
  };

  /**
   * Runs a user action the way a click does: without waiting on it. An
   * approval inside a batch resolves only once the whole batch is sent, so
   * the step ends when the runtime and the server are idle, and a rejection
   * lands in `errors` whenever it arrives.
   */
  const act = async (action: () => Promise<void>) => {
    if (disposed) {
      panic("The page was closed");
    }
    void action().catch((error: unknown) => {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    });
    await settle();
  };

  const messages = () => runtime.getSnapshot().messages;
  const cards = () => cardsOf(messages());
  const requireCard = (toolCallId: string): LiveCard =>
    cards().find((card) => card.toolCallId === toolCallId) ??
    panic(`The card for ${toolCallId} is not on screen`);

  return {
    approve: async (toolCallId, approved) => {
      const card = requireCard(toolCallId);
      const approvalId =
        card.kind === "approval"
          ? card.approvalId
          : panic(`${toolCallId} is not an approval card`);
      await act(
        async () =>
          await runtime.resolveToolApproval({ approved, id: approvalId }),
      );
    },
    answer: async (toolCallId, output) => {
      const card = requireCard(toolCallId);
      if (card.kind !== "answer") {
        panic(`${toolCallId} is not an answerable card`);
      }
      await act(
        async () =>
          await runtime.addToolResult({
            output,
            tool: card.toolName,
            toolCallId,
          }),
      );
    },
    cards,
    dispose: () => {
      disposed = true;
      runtime.stop();
    },
    messages,
    resend: async () => {
      await act(async () => await runtime.reload());
    },
    sendUserMessage: async (id, text) => {
      await act(
        async () =>
          await web.sendThreadChatMessage(runtime, { content: text, id }),
      );
    },
    takeErrors: () => errors.splice(0),
  };
};
