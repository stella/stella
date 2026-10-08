import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import type {
  AppEventMap,
  McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import { Result } from "better-result";

import { parseLegalCitationHttpUrl } from "@stll/api-contract/legal-citation-links";
import { createDetached } from "@stll/errors";

import type { PresentationApp } from "../manifest";
import { appLocale } from "./locale";

const applyHostPresentation = (context: McpUiHostContext) => {
  const locale = appLocale(context.locale);
  document.documentElement.lang = locale.locale;
  document.documentElement.dir = locale.direction;
  document.title = locale.messages.title;
  if (context.theme !== undefined) {
    applyDocumentTheme(context.theme);
    document.documentElement.classList.toggle("dark", context.theme === "dark");
  }
  if (context.styles?.variables !== undefined) {
    applyHostStyleVariables(context.styles.variables);
  }
};

type OpenPresentationLinkOptions = {
  app: Pick<App, "openLink">;
  url: string;
  fail: (message: string | null) => void;
};
const openPresentationLink = async ({
  app,
  url,
  fail,
}: OpenPresentationLinkOptions) => {
  const parsed = parseLegalCitationHttpUrl(url);
  if (parsed === null) {
    fail(null);
    return;
  }
  const opened = await Result.tryPromise(async () =>
    app.openLink({ url: parsed.href }),
  );
  if (Result.isError(opened)) {
    fail(opened.error.message);
  } else if (opened.value.isError === true) {
    fail(null);
  }
};

type ResultState<View> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; view: View }
  | { status: "error"; message: string | null };
type ToolName = PresentationApp["callableTools"][number];
type AppSnapshot<View> = {
  context: McpUiHostContext;
  input: Record<string, unknown>;
  tool: ToolName;
  result: ResultState<View>;
};
type ReadCall = { name: ToolName; arguments: Record<string, unknown> };

type PresentationBridgeOptions<View> = {
  manifest: PresentationApp;
  parse: (payload: unknown, input: Record<string, unknown>) => View | undefined;
};

type RequestPresentationToolOptions = {
  app: Pick<App, "callServerTool">;
  manifest: PresentationApp;
  request: ReadCall;
};
const requestPresentationTool = async ({
  app,
  manifest,
  request,
}: RequestPresentationToolOptions) => {
  if (!manifest.callableTools.some((name) => name === request.name)) {
    return undefined;
  }
  const called = await Result.tryPromise(async () =>
    app.callServerTool(request),
  );
  if (Result.isError(called) || called.value.isError === true) {
    return undefined;
  }
  return called.value;
};

export const createPresentationBridge = <View>({
  manifest,
  parse,
}: PresentationBridgeOptions<View>) => {
  const app = new App(
    { name: `stella ${manifest.directory}`, version: "1.0.0" },
    {},
  );
  const listeners = new Set<() => void>();
  let snapshot: AppSnapshot<View> = {
    context: {},
    input: {},
    tool: manifest.linkedTools[0],
    result: { status: "idle" },
  };
  let generation = 0;
  let lastCall: ReadCall | undefined;
  const publish = (result: ResultState<View>) => {
    snapshot = {
      context: snapshot.context,
      input: snapshot.input,
      tool: snapshot.tool,
      result,
    };
    for (const listener of listeners) {
      listener();
    }
  };
  const receive = (result: Awaited<ReturnType<App["callServerTool"]>>) => {
    if (result.isError === true) {
      publish({
        status: "error",
        message:
          result.content.find((part) => part.type === "text")?.text ?? null,
      });
      return;
    }
    const view = parse(result.structuredContent, snapshot.input);
    publish(
      view === undefined
        ? { status: "error", message: null }
        : { status: "ready", view },
    );
  };
  const hostContext = (context: McpUiHostContext) => {
    const merged = { ...snapshot.context, ...context };
    const name = merged.toolInfo?.tool.name;
    snapshot = {
      context: merged,
      input: snapshot.input,
      tool:
        name === undefined
          ? snapshot.tool
          : (manifest.linkedTools.find((entry) => entry === name) ??
            snapshot.tool),
      result: snapshot.result,
    };
    applyHostPresentation(merged);
    for (const listener of listeners) {
      listener();
    }
  };
  const toolInput = ({ arguments: input }: AppEventMap["toolinput"]) => {
    generation += 1;
    lastCall = undefined;
    snapshot = {
      context: snapshot.context,
      tool: snapshot.tool,
      input: input ?? {},
      result: { status: "loading" },
    };
    for (const listener of listeners) {
      listener();
    }
  };
  const toolResult = (result: AppEventMap["toolresult"]) => {
    hostContext(app.getHostContext() ?? {});
    generation += 1;
    receive(result);
  };
  const toolCancelled = ({ reason }: AppEventMap["toolcancelled"]) => {
    generation += 1;
    publish({ status: "error", message: reason ?? null });
  };
  app.addEventListener("hostcontextchanged", hostContext);
  app.addEventListener("toolinput", toolInput);
  app.addEventListener("toolresult", toolResult);
  app.addEventListener("toolcancelled", toolCancelled);
  app.onteardown = () => {
    generation += 1;
    app.removeEventListener("hostcontextchanged", hostContext);
    app.removeEventListener("toolinput", toolInput);
    app.removeEventListener("toolresult", toolResult);
    app.removeEventListener("toolcancelled", toolCancelled);
    listeners.clear();
    return {};
  };
  const reportAppError: NonNullable<typeof app.onerror> = ({ message }) =>
    publish({ status: "error", message });
  Reflect.set(app, "onerror", reportAppError);

  // Paged reads and previews own their request state; a late failure must not replace a newer opening.
  const requestTool = (request: ReadCall) =>
    requestPresentationTool({ app, manifest, request });
  const requestDisplayMode = async (
    mode: "fullscreen" | "inline",
    onError?: (message: string | null) => void,
  ) => {
    const fail =
      onError ??
      ((message: string | null) => publish({ status: "error", message }));
    if (!snapshot.context.availableDisplayModes?.includes(mode)) {
      return;
    }
    const currentGeneration = generation;
    const requested = await Result.tryPromise(async () =>
      app.requestDisplayMode({ mode }),
    );
    if (currentGeneration !== generation) {
      return;
    }
    if (Result.isError(requested)) {
      fail(requested.error.message);
      return;
    }
    hostContext({ displayMode: requested.value.mode });
  };
  const call = async (request: ReadCall): Promise<void> => {
    // The typed call list and its runtime check share the manifest the CI census reads.
    if (!manifest.callableTools.some((name) => name === request.name)) {
      publish({ status: "error", message: null });
      return;
    }
    lastCall = request;
    const currentGeneration = ++generation;
    publish({ status: "loading" });
    const called = await Result.tryPromise(async () =>
      app.callServerTool(request),
    );
    if (currentGeneration !== generation) {
      return;
    }
    if (Result.isError(called)) {
      publish({ status: "error", message: called.error.message });
      return;
    }
    snapshot = {
      context: snapshot.context,
      input: request.arguments,
      tool: request.name,
      result: snapshot.result,
    };
    receive(called.value);
  };
  const openLink = async (
    url: string,
    onError?: (message: string | null) => void,
  ): Promise<void> => {
    const fail =
      onError ??
      ((message: string | null) => publish({ status: "error", message }));
    await openPresentationLink({ app, url, fail });
  };
  const connect = async (): Promise<void> => {
    const connected = await Result.tryPromise(async () => app.connect());
    if (Result.isError(connected)) {
      publish({ status: "error", message: connected.error.message });
      return;
    }
    hostContext(app.getHostContext() ?? {});
  };
  return {
    detached: createDetached(() => publish({ status: "error", message: null })),
    connect,
    requestTool,
    requestFullscreen: async (onError?: (message: string | null) => void) =>
      await requestDisplayMode("fullscreen", onError),
    requestInline: async (onError?: (message: string | null) => void) =>
      await requestDisplayMode("inline", onError),
    supportsTools: () => app.getHostCapabilities()?.serverTools !== undefined,
    call,
    openLink,
    retry: async () => {
      if (lastCall !== undefined) {
        await call(lastCall);
      } else {
        await call({ name: snapshot.tool, arguments: snapshot.input });
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
  };
};
