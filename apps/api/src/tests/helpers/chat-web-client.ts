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
//
// Which parts are cards the user can act on is decided in React components
// (see `cardsOf`), so that one rule is mirrored here from the web predicates
// it is built on, and `chat-web-client.test.ts` pins the mirror to them.

const WEB_CHAT_RUNTIME_URL = new URL(
  "../../../../web/src/features/chat/chat-runtime.ts",
  import.meta.url,
).href;
const WEB_CHAT_UI_TOOLS_URL = new URL(
  "../../../../web/src/components/chat/chat-ui-tools.ts",
  import.meta.url,
).href;
const WEB_CHAT_USER_ACTIONS_URL = new URL(
  "../../../../web/src/components/chat/chat-user-actions.ts",
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

/** An assistant message's action, as `chat-user-actions.ts` offers it. */
type AssistantMessageActionGate = (state: {
  isGenerating: boolean;
  messageId: string;
  messages: readonly UIMessage[];
}) => boolean;

type WebChatModules = {
  /** `chat-user-actions.ts`: every action the thread page offers. */
  chatUserActions: readonly string[];
  canForkAssistantMessage: AssistantMessageActionGate;
  canRetryAssistantMessage: AssistantMessageActionGate;
  /** `chat-ui-tools.ts`: the failure a stored turn outcome reports. */
  getChatAssistantTurnError: (message: UIMessage | null) => Error | undefined;
  /** `chat-ui-tools.ts`: the answer whose cards the page still waits on. */
  getAwaitedAssistantMessageId: (
    messages: readonly UIMessage[],
  ) => string | null;
  isChatTurnGenerating: (state: {
    hasError: boolean;
    messages: readonly UIMessage[];
    requestActive: boolean;
    sessionGenerating: boolean;
  }) => boolean;
  /** `chat-ui-tools.ts`: a tool part that renders as an approval card. */
  isApprovalPart: (part: unknown) => boolean;
  /** `chat-ui-tools.ts`: a stored call of a tool the web app does not know,
   *  rendered as a plain tool row. */
  isOpaquePersistedChatToolCallPart: (part: unknown) => boolean;
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
  const userActions: unknown = await import(WEB_CHAT_USER_ACTIONS_URL);
  const actionList: unknown =
    typeof userActions === "object" && userActions !== null
      ? Reflect.get(userActions, "CHAT_USER_ACTIONS")
      : undefined;
  if (
    typeof actionList !== "object" ||
    actionList === null ||
    !hasFunction(userActions, "canForkAssistantMessage") ||
    !hasFunction(userActions, "canRetryAssistantMessage") ||
    !hasFunction(userActions, "isChatTurnGenerating") ||
    !hasFunction(uiTools, "getChatAssistantTurnError")
  ) {
    return panic("The web chat modules no longer export the chat actions");
  }
  if (
    !hasFunction(runtime, "createChatRuntime") ||
    !hasFunction(runtime, "sendThreadChatMessage") ||
    !hasFunction(runtime, "resetChatRequestStateForTests") ||
    !hasFunction(uiTools, "sanitizeRunningToolCalls") ||
    !hasFunction(uiTools, "isApprovalPart") ||
    !hasFunction(uiTools, "getAwaitedAssistantMessageId") ||
    !hasFunction(uiTools, "isOpaquePersistedChatToolCallPart")
  ) {
    return panic("The web chat modules no longer export the chat runtime");
  }
  // The functions exist (checked above); their signatures are the web app's,
  // which this file states once in `WebChatModules`.
  loadedWebChat = asTestRaw<WebChatModules>({
    canForkAssistantMessage: userActions.canForkAssistantMessage,
    canRetryAssistantMessage: userActions.canRetryAssistantMessage,
    chatUserActions: Object.keys(actionList),
    createChatRuntime: runtime.createChatRuntime,
    getAwaitedAssistantMessageId: uiTools.getAwaitedAssistantMessageId,
    getChatAssistantTurnError: uiTools.getChatAssistantTurnError,
    isChatTurnGenerating: userActions.isChatTurnGenerating,
    isApprovalPart: uiTools.isApprovalPart,
    isOpaquePersistedChatToolCallPart:
      uiTools.isOpaquePersistedChatToolCallPart,
    resetChatRequestStateForTests: runtime.resetChatRequestStateForTests,
    sanitizeRunningToolCalls: uiTools.sanitizeRunningToolCalls,
    sendThreadChatMessage: runtime.sendThreadChatMessage,
  });
  return loadedWebChat;
};

/** One card the user can act on in the live view. */
export type LiveCard =
  | {
      approvalId: string;
      kind: "approval";
      toolCallId: string;
      toolName: string;
    }
  | { kind: "answer"; toolCallId: string; toolName: string };

/**
 * The cards `messages` renders for the user to act on, in display order.
 *
 * A mirror of the web app's rendering, which has no pure selector for it:
 * `renderPart` in `apps/web/src/components/chat/chat-thread-messages.tsx`
 * shows an unknown tool's stored call as a plain row (line 1538), an
 * `ask-user` call as `AskUserCard` (line 1549), and any `isApprovalPart` call
 * as `ToolApprovalCard` (line 1623). `ToolApprovalCard` offers Allow and Deny
 * while the part is `approval-requested` (`tool-approval-card.tsx:732`);
 * `AskUserCard` offers its form once the input has streamed and until the
 * call is `complete` (`ask-user-card.tsx:164`). Either card offers its
 * controls only on the answer the page still waits on
 * (`getAwaitedAssistantMessageId`, the `isAwaitingUser` prop of both cards):
 * a later user message withdraws them. The web predicates are called, not
 * copied.
 */
export const cardsOf = (
  web: Pick<
    WebChatModules,
    | "getAwaitedAssistantMessageId"
    | "isApprovalPart"
    | "isOpaquePersistedChatToolCallPart"
  >,
  messages: readonly UIMessage[],
): LiveCard[] => {
  const awaited = web.getAwaitedAssistantMessageId(messages);
  return messages.flatMap(({ id, parts }) =>
    id !== awaited
      ? []
      : parts.flatMap((part): LiveCard[] => {
          if (
            part.type !== "tool-call" ||
            web.isOpaquePersistedChatToolCallPart(part)
          ) {
            return [];
          }
          if (part.name === ASK_USER_TOOL_NAME) {
            return part.state !== "input-streaming" &&
              part.state !== "complete" &&
              part.input !== undefined &&
              part.input !== null
              ? [{ kind: "answer", toolCallId: part.id, toolName: part.name }]
              : [];
          }
          return web.isApprovalPart(part) &&
            part.state === "approval-requested" &&
            part.approval !== undefined
            ? [
                {
                  approvalId: part.approval.id,
                  kind: "approval",
                  toolCallId: part.id,
                  toolName: part.name,
                },
              ]
            : [];
        }),
  );
};

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
  /** Whether the runtime reports an error and has a request open. */
  runtimeState: () => { hasError: boolean; requestActive: boolean };
  sendUserMessage: (id: string, text: string) => Promise<void>;
  /** Sends a message and returns once the live view satisfies `until`,
   *  without waiting for the turn to end. */
  startUserMessage: (
    id: string,
    text: string,
    until: (messages: readonly UIMessage[]) => boolean,
  ) => Promise<void>;
  /** The page posts a client-executed tool's result on its own, with no
   *  card to answer (a drafted document). */
  runClientTool: (
    toolCallId: string,
    tool: string,
    output: unknown,
  ) => Promise<void>;
  /** The composer's Stop. */
  stop: () => Promise<void>;
  /** Waits until no request is open and the runtime is idle. */
  settle: () => Promise<void>;
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
  const cards = () => cardsOf(web, messages());
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
    runtimeState: () => {
      const { error, isLoading, status } = runtime.getSnapshot();
      return {
        hasError: error !== undefined,
        requestActive:
          isLoading || status === "submitted" || status === "streaming",
      };
    },
    sendUserMessage: async (id, text) => {
      await act(
        async () =>
          await web.sendThreadChatMessage(runtime, { content: text, id }),
      );
    },
    runClientTool: async (toolCallId, tool, output) => {
      await act(
        async () => await runtime.addToolResult({ output, tool, toolCallId }),
      );
    },
    settle,
    startUserMessage: async (id, text, until) => {
      void web
        .sendThreadChatMessage(runtime, { content: text, id })
        .catch((error: unknown) => {
          errors.push(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      for (let tick = 0; tick < MAX_SETTLE_TICKS; tick += 1) {
        await nextTick();
        if (until(messages())) {
          return;
        }
      }
      panic("The live view never reached the awaited state");
    },
    stop: async () => {
      runtime.stop();
      await settle();
    },
    takeErrors: () => errors.splice(0),
  };
};
