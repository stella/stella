import type { App, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { panic, Result } from "better-result";

import { createDetached } from "@stll/errors";

import { appLocale } from "./locale";

export const INLINE_APP_HEIGHT_CAP = 600;

type AppSizeReporterOptions = {
  app: Pick<App, "sendSizeChanged">;
  measure: () => {
    contentHeight: number;
    toolbarHeight: number;
    viewportHeight: number;
    width: number;
  };
  apply: (height: number) => void;
  onFailure: () => void;
};

/** All host size notifications pass through this boundary, including mode changes. */
export const createAppSizeReporter = ({
  app,
  measure,
  apply,
  onFailure,
}: AppSizeReporterOptions) => {
  let context: McpUiHostContext = {};
  const report = async () => {
    const { contentHeight, toolbarHeight, viewportHeight, width } = measure();
    const dimensions = context.containerDimensions;
    let hostHeight: number | undefined;
    if (dimensions !== undefined) {
      hostHeight =
        "height" in dimensions ? dimensions.height : dimensions.maxHeight;
    }
    let height = Math.min(
      contentHeight + toolbarHeight,
      INLINE_APP_HEIGHT_CAP,
      hostHeight ?? INLINE_APP_HEIGHT_CAP,
    );
    if (context.displayMode === "fullscreen") {
      height =
        dimensions !== undefined && "height" in dimensions
          ? dimensions.height
          : viewportHeight;
    }
    apply(height);
    const sent = await Result.tryPromise(async () =>
      app.sendSizeChanged({ height, width }),
    );
    if (Result.isError(sent)) {
      onFailure();
    }
  };
  return {
    report,
    setContext: async (update: McpUiHostContext) => {
      context = { ...context, ...update };
      await report();
    },
  };
};

type AppViewportOptions = {
  app: Pick<
    App,
    | "addEventListener"
    | "getHostContext"
    | "removeEventListener"
    | "requestDisplayMode"
    | "sendSizeChanged"
  >;
  onFailure: () => void;
  onDisplayModeChange?: (context: McpUiHostContext) => void;
};

/** The viewport currently wrapped around each app root. */
const mountedViewports = new WeakMap<HTMLElement, () => void>();

/**
 * Shared chrome keeps the fullscreen action reachable while the app scrolls.
 * Mounting again replaces the current viewport, and stopping restores the
 * root where it was.
 */
export const mountAppViewport = ({
  app,
  onFailure,
  onDisplayModeChange,
}: AppViewportOptions) => {
  const content =
    document.querySelector<HTMLElement>("#app") ??
    panic("MCP app root is missing");
  mountedViewports.get(content)?.();
  const shell = document.createElement("div");
  shell.dataset["appShell"] = "";
  const toolbar = document.createElement("div");
  toolbar.dataset["appToolbar"] = "";
  const button = document.createElement("button");
  button.type = "button";
  button.dataset["appFullscreen"] = "";
  toolbar.append(button);
  const viewport = document.createElement("div");
  viewport.dataset["appViewport"] = "";
  content.before(shell);
  viewport.append(content);
  shell.append(toolbar, viewport);
  const detached = createDetached(onFailure);
  let context = app.getHostContext() ?? {};
  let stopped = false;
  const reporter = createAppSizeReporter({
    app,
    measure: () => ({
      contentHeight: Math.ceil(content.getBoundingClientRect().height),
      toolbarHeight: Math.ceil(toolbar.getBoundingClientRect().height),
      viewportHeight: window.innerHeight,
      width: Math.ceil(shell.getBoundingClientRect().width),
    }),
    apply: (height) => {
      shell.style.height = `${height}px`;
    },
    onFailure,
  });
  const update = async (next: McpUiHostContext) => {
    context = { ...context, ...next };
    toolbar.hidden =
      context.displayMode === "fullscreen" ||
      !context.availableDisplayModes?.includes("fullscreen");
    button.textContent = appLocale(context.locale).t("openFullReader");
    await reporter.setContext(context);
  };
  const openFullscreen = async () => {
    button.disabled = true;
    const requested = await Result.tryPromise(async () =>
      app.requestDisplayMode({ mode: "fullscreen" }),
    );
    button.disabled = false;
    if (stopped) {
      return;
    }
    if (Result.isError(requested)) {
      onFailure();
      return;
    }
    const next = { displayMode: requested.value.mode };
    onDisplayModeChange?.(next);
    await update(next);
  };
  button.addEventListener("click", () => {
    detached(openFullscreen(), "mcp-viewport.open-fullscreen");
  });
  const report = () => {
    detached(reporter.report(), "mcp-viewport.report-size");
  };
  const observer = new ResizeObserver(report);
  observer.observe(content);
  observer.observe(toolbar);
  observer.observe(document.documentElement);
  window.addEventListener("resize", report);
  const hostContextChanged = (next: McpUiHostContext) => {
    detached(update(next), "mcp-viewport.update-context");
  };
  app.addEventListener("hostcontextchanged", hostContextChanged);
  detached(update(context), "mcp-viewport.initialize");
  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    observer.disconnect();
    window.removeEventListener("resize", report);
    app.removeEventListener("hostcontextchanged", hostContextChanged);
    shell.before(content);
    shell.remove();
    mountedViewports.delete(content);
  };
  mountedViewports.set(content, stop);
  return stop;
};
