import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { Result } from "better-result";

import { parseLegalCitationHttpUrl } from "@stll/api-contract/legal-citation-links";
import { createDetached } from "@stll/errors";

import type { PresentationApp } from "../manifest";
import { appLocale } from "./locale";

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
    const locale = appLocale(merged.locale);
    document.documentElement.lang = locale.locale;
    document.documentElement.dir = locale.direction;
    document.title = locale.messages.title;
    if (merged.theme !== undefined) {
      applyDocumentTheme(merged.theme);
      document.documentElement.classList.toggle(
        "dark",
        merged.theme === "dark",
      );
    }
    if (merged.styles?.variables !== undefined) {
      applyHostStyleVariables(merged.styles.variables);
    }
    for (const listener of listeners) {
      listener();
    }
  };
  app.onhostcontextchanged = hostContext;
  app.ontoolinput = ({ arguments: input }) => {
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
  app.ontoolresult = (result) => {
    generation += 1;
    receive(result);
  };
  app.ontoolcancelled = ({ reason }) => {
    generation += 1;
    publish({ status: "error", message: reason ?? null });
  };
  const reportAppError: NonNullable<typeof app.onerror> = ({ message }) =>
    publish({ status: "error", message });
  Reflect.set(app, "onerror", reportAppError);

  const call = async (request: ReadCall): Promise<void> => {
    // The typed call list and its runtime check share the manifest the CI census reads.
    if (!manifest.callableTools.some((name) => name === request.name)) {
      publish({ status: "error", message: null });
      return;
    }
    lastCall = request;
    const currentGeneration = ++generation;
    publish({ status: "loading" });
    const called = await Result.tryPromise(() => app.callServerTool(request));
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
  const openLink = async (url: string): Promise<void> => {
    const parsed = parseLegalCitationHttpUrl(url);
    if (parsed === null) {
      publish({ status: "error", message: null });
      return;
    }
    const opened = await Result.tryPromise(() =>
      app.openLink({ url: parsed.href }),
    );
    if (Result.isError(opened)) {
      publish({ status: "error", message: opened.error.message });
    } else if (opened.value.isError === true) {
      publish({ status: "error", message: null });
    }
  };
  const connect = async (): Promise<void> => {
    const connected = await Result.tryPromise(() => app.connect());
    if (Result.isError(connected)) {
      publish({ status: "error", message: connected.error.message });
      return;
    }
    hostContext(app.getHostContext() ?? {});
  };
  return {
    detached: createDetached(() => publish({ status: "error", message: null })),
    connect,
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
