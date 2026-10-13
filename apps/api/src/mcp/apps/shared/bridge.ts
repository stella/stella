import {
  App,
  applyDocumentTheme,
  applyHostFonts,
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
import {
  appFailure,
  createAppRequestId,
  formatAppFailure,
  toolAppFailure,
} from "./app-error";
import type { AppFailure } from "./app-error";
import { appLocale } from "./locale";
import {
  projectAppToolArguments,
  validateAppToolArguments,
} from "./tool-input";

export type AppToolResult = Awaited<ReturnType<App["callServerTool"]>>;

export const parseAppToolPayload = (result: AppToolResult): unknown => {
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  const text = result.content.find((part) => part.type === "text")?.text;
  if (text === undefined) {
    return undefined;
  }
  const parsed = Result.try((): unknown => JSON.parse(text));
  return Result.isError(parsed) ? undefined : parsed.value;
};

export const applyHostStyles = (context: McpUiHostContext) => {
  if (context.theme !== undefined) {
    applyDocumentTheme(context.theme);
    document.documentElement.classList.toggle("dark", context.theme === "dark");
  }
  if (context.styles?.variables !== undefined) {
    applyHostStyleVariables(context.styles.variables);
  }
  if (context.styles?.css?.fonts !== undefined) {
    applyHostFonts(context.styles.css.fonts);
  }
};

const applyHostPresentation = (
  context: McpUiHostContext,
  title: string | undefined,
) => {
  const locale = appLocale(context.locale);
  document.documentElement.lang = locale.locale;
  document.documentElement.dir = locale.direction;
  document.title = title ?? locale.messages.title;
  applyHostStyles(context);
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
  | { status: "error"; message: string; failure: AppFailure };
type ToolName = PresentationApp["callableTools"][number];
type AppSnapshot<View> = {
  context: McpUiHostContext;
  input: Record<string, unknown>;
  tool: ToolName;
  result: ResultState<View>;
};
type ReadCall = { name: ToolName; arguments: Record<string, unknown> };

type PresentationHost = Pick<
  App,
  | "callServerTool"
  | "addEventListener"
  | "removeEventListener"
  | "getHostContext"
  | "getHostCapabilities"
  | "connect"
  | "openLink"
  | "requestDisplayMode"
  | "onerror"
  | "onteardown"
>;

type PresentationBridgeOptions<View> = {
  host?: PresentationHost;
  title?: (context: McpUiHostContext) => string;
  manifest: PresentationApp;
  parse: (payload: unknown, input: Record<string, unknown>) => View | undefined;
};

type RequestPresentationToolOptions = {
  app: Pick<App, "callServerTool">;
  manifest: PresentationApp;
  request: ReadCall;
};
export const requestPresentationTool = async ({
  app,
  manifest,
  request,
}: RequestPresentationToolOptions) => {
  const requestId = createAppRequestId();
  if (!manifest.callableTools.some((name) => name === request.name)) {
    return {
      status: "error",
      failure: appFailure("unavailable", requestId),
    } as const;
  }
  const arguments_ = projectAppToolArguments(request.name, request.arguments);
  const checked = validateAppToolArguments(request.name, arguments_);
  if (checked.status === "invalid") {
    return {
      status: "error",
      failure: {
        ...appFailure("invalid_arguments", requestId),
        fields: checked.fields,
      },
    } as const;
  }
  const called = await Result.tryPromise(async () =>
    app.callServerTool({ name: request.name, arguments: checked.arguments }),
  );
  if (Result.isError(called)) {
    return {
      status: "error",
      failure: appFailure("unavailable", requestId, true),
    } as const;
  }
  return {
    status: "ready",
    result: called.value,
    requestId,
    arguments: checked.arguments,
  } as const;
};

type LocalizedRequestToolOptions = RequestPresentationToolOptions & {
  formatFailure: (failure: AppFailure) => string;
};
const requestLocalizedPresentationTool = async ({
  app,
  manifest,
  request,
  formatFailure,
}: LocalizedRequestToolOptions): Promise<AppToolResult> => {
  const called = await requestPresentationTool({ app, manifest, request });
  if (called.status === "ready" && called.result.isError !== true) {
    return called.result;
  }
  const failure =
    called.status === "error"
      ? called.failure
      : toolAppFailure(parseAppToolPayload(called.result), called.requestId);
  return {
    isError: true,
    structuredContent: { appFailure: failure },
    content: [
      {
        type: "text",
        text: formatFailure(failure),
      },
    ],
  };
};

type PresentationDisplayModeOptions = {
  app: Pick<App, "requestDisplayMode">;
  context: McpUiHostContext;
  mode: "fullscreen" | "inline";
  isCurrent: () => boolean;
  fail: (message: string | null) => void;
  hostContext: (context: McpUiHostContext) => void;
};
const requestPresentationDisplayMode = async ({
  app,
  context,
  mode,
  isCurrent,
  fail,
  hostContext,
}: PresentationDisplayModeOptions) => {
  if (!context.availableDisplayModes?.includes(mode)) {
    return;
  }
  const requested = await Result.tryPromise(async () =>
    app.requestDisplayMode({ mode }),
  );
  if (!isCurrent()) {
    return;
  }
  if (Result.isError(requested)) {
    fail(requested.error.message);
    return;
  }
  hostContext({ displayMode: requested.value.mode });
};

type HostContextSnapshotOptions<View> = {
  snapshot: AppSnapshot<View>;
  context: McpUiHostContext;
  manifest: PresentationApp;
};
const mergeHostContextSnapshot = <View>({
  snapshot,
  context,
  manifest,
}: HostContextSnapshotOptions<View>) => {
  const merged = { ...snapshot.context, ...context };
  const name = merged.toolInfo?.tool.name;
  return {
    context: merged,
    input: snapshot.input,
    tool: manifest.linkedTools.find((entry) => entry === name) ?? snapshot.tool,
    result:
      snapshot.result.status === "error"
        ? {
            status: "error",
            failure: snapshot.result.failure,
            message: formatAppFailure(
              snapshot.result.failure,
              appLocale(merged.locale).t,
            ),
          }
        : snapshot.result,
  } satisfies AppSnapshot<View>;
};

export const createPresentationBridge = <View>({
  manifest,
  parse,
  title,
  host,
}: PresentationBridgeOptions<View>) => {
  const app =
    host ??
    new App({ name: `stella ${manifest.directory}`, version: "1.0.0" }, {});
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
  const publishFailure = (failure: AppFailure) =>
    publish({
      status: "error",
      failure,
      message: formatAppFailure(failure, appLocale(snapshot.context.locale).t),
    });
  const receive = (result: AppToolResult, requestId = createAppRequestId()) => {
    const payload = parseAppToolPayload(result);
    if (result.isError === true) {
      publishFailure(toolAppFailure(payload, requestId));
      return;
    }
    const view = parse(payload, snapshot.input);
    if (view === undefined) {
      publishFailure(appFailure("invalid_response", requestId));
      return;
    }
    publish({ status: "ready", view });
  };
  const hostContext = (context: McpUiHostContext) => {
    snapshot = mergeHostContextSnapshot({ snapshot, context, manifest });
    applyHostPresentation(snapshot.context, title?.(snapshot.context));
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
  const toolCancelled = (_event: AppEventMap["toolcancelled"]) => {
    generation += 1;
    publishFailure(appFailure("cancelled", createAppRequestId()));
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
  const reportAppError: NonNullable<typeof app.onerror> = () =>
    publishFailure(appFailure("unavailable", createAppRequestId(), true));
  Reflect.set(app, "onerror", reportAppError);

  // Paged reads and previews own their request state.
  const requestTool = (request: ReadCall) =>
    requestLocalizedPresentationTool({
      app,
      manifest,
      request,
      formatFailure: (failure) =>
        formatAppFailure(failure, appLocale(snapshot.context.locale).t),
    });
  const requestDisplayMode = (
    mode: "fullscreen" | "inline",
    onError?: (message: string | null) => void,
  ) => {
    const currentGeneration = generation;
    return requestPresentationDisplayMode({
      app,
      context: snapshot.context,
      mode,
      isCurrent: () => currentGeneration === generation,
      fail:
        onError ??
        (() =>
          publishFailure(
            appFailure("unavailable", createAppRequestId(), true),
          )),
      hostContext,
    });
  };
  const call = async (request: ReadCall): Promise<void> => {
    const attempted = {
      name: request.name,
      arguments: projectAppToolArguments(request.name, request.arguments),
    };
    lastCall = attempted;
    snapshot = {
      context: snapshot.context,
      input: attempted.arguments,
      tool: attempted.name,
      result: snapshot.result,
    };
    const currentGeneration = ++generation;
    publish({ status: "loading" });
    const called = await requestPresentationTool({
      app,
      manifest,
      request: attempted,
    });
    if (currentGeneration !== generation) {
      return;
    }
    if (called.status === "error") {
      publishFailure(called.failure);
      return;
    }
    receive(called.result, called.requestId);
  };
  const openLink = async (
    url: string,
    onError?: (message: string | null) => void,
  ): Promise<void> => {
    const fail =
      onError ??
      (() =>
        publishFailure(appFailure("unavailable", createAppRequestId(), true)));
    await openPresentationLink({ app, url, fail });
  };
  const connect = async (): Promise<void> => {
    applyHostPresentation(snapshot.context, title?.(snapshot.context));
    const connected = await Result.tryPromise(async () => app.connect());
    if (Result.isError(connected)) {
      publishFailure(appFailure("unavailable", createAppRequestId(), true));
      return;
    }
    hostContext(app.getHostContext() ?? {});
  };
  return {
    detached: createDetached(() =>
      publishFailure(appFailure("unavailable", createAppRequestId(), true)),
    ),
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
