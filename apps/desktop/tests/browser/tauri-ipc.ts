import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/** One native call the page made, plugin calls included. */
export type TauriInvocation = {
  args: Record<string, unknown>;
  command: string;
};

/** The page-side boundary a spec's command handlers can use. */
type TauriPageIpc = {
  /** Every invoke in call order. */
  invocations: TauriInvocation[];
  /** Calls the handlers refused; `unexpectedTauriCalls` reads it back. */
  unexpected: string[];
  /** Delivers an event to every live listener, as the native side emits it. */
  emit: (event: string, payload: unknown) => void;
};

type TauriCommandHandler = (args: Record<string, unknown>) => unknown;

/** A command without a handler resolves `undefined` or rejects as unexpected. */
type UnhandledCommandPolicy = "resolveUndefined" | "rejectAsUnexpected";

type PageConfig = {
  commands: readonly string[];
  global: string;
  unhandled: UnhandledCommandPolicy;
  windowLabel: string;
};

type InstallTauriIpcOptions<Arg> = {
  windowLabel: string;
  unhandled: UnhandledCommandPolicy;
  /** Serialized into the page as JSON. */
  arg: Arg;
  /**
   * Runs in the page before any app module and returns the command handlers.
   * It is serialized into the page, so it can use only `arg` and `ipc`.
   */
  handlers: (
    arg: Arg,
    ipc: TauriPageIpc,
  ) => Record<string, TauriCommandHandler>;
};

const IPC_GLOBAL = "__STELLA_TAURI_IPC__";

// The registration list is the source of truth for command names, so a
// handler for a renamed or removed command fails instead of never running.
const DESKTOP_COMMANDS = [
  ...readFileSync(
    new URL("../../src-tauri/src/command_manifest.rs", import.meta.url),
    "utf-8",
  ).matchAll(/[=]>\s*"([a-z_]+)"/gu),
].flatMap(([, name]) => (name === undefined ? [] : [name]));
if (DESKTOP_COMMANDS.length === 0) {
  throw new TypeError("The desktop command manifest lists no commands");
}

// Serialized into the page: it may reference only its parameters.
const installInPage = (
  createHandlers: (
    arg: unknown,
    ipc: TauriPageIpc,
  ) => Record<string, TauriCommandHandler>,
  arg: unknown,
  { commands, global, unhandled, windowLabel }: PageConfig,
) => {
  const invocations: TauriInvocation[] = [];
  const unexpected: string[] = [];
  const callbacks = new Map<number, (data: unknown) => unknown>();
  const listeners = new Map<string, number[]>();
  let nextCallbackId = 1;
  const emit = (event: string, payload: unknown) => {
    const ids = listeners.get(event) ?? [];
    if (ids.length === 0) {
      throw new TypeError(`No listener is installed for ${event}`);
    }
    for (const id of ids) {
      callbacks.get(id)?.({ event, id, payload });
    }
  };
  const ipc = { emit, invocations, unexpected };
  const handlers = createHandlers(arg, ipc);
  const unknownCommands = Object.keys(handlers).filter(
    (command) => !commands.includes(command),
  );
  if (unknownCommands.length > 0) {
    throw new TypeError(
      `Handlers name commands the app does not register: ${unknownCommands.join(", ")}`,
    );
  }
  Reflect.set(window, global, ipc);
  Reflect.set(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
    unregisterListener: () => undefined,
  });
  Reflect.set(window, "__TAURI_INTERNALS__", {
    callbacks,
    convertFileSrc: (path: string) => path,
    invoke: async (command: string, args: Record<string, unknown> = {}) => {
      invocations.push({ args, command });
      const event = args["event"];
      if (command === "plugin:event|listen") {
        const handler = args["handler"];
        if (typeof event !== "string" || typeof handler !== "number") {
          throw new TypeError("Event listener without an event or handler");
        }
        const ids = listeners.get(event) ?? [];
        ids.push(handler);
        listeners.set(event, ids);
        return handler;
      }
      if (command === "plugin:event|unlisten") {
        if (typeof event === "string") {
          listeners.set(
            event,
            (listeners.get(event) ?? []).filter((id) => id !== args["eventId"]),
          );
        }
        return undefined;
      }
      if (Object.hasOwn(handlers, command)) {
        return await handlers[command]?.(args);
      }
      if (unhandled === "rejectAsUnexpected") {
        unexpected.push(command);
        throw new TypeError(`Unexpected native command: ${command}`);
      }
      return undefined;
    },
    metadata: {
      currentWebview: { label: windowLabel, windowLabel },
      currentWindow: { label: windowLabel },
    },
    runCallback: (id: number, data: unknown) => callbacks.get(id)?.(data),
    transformCallback: (
      callback: ((data: unknown) => unknown) | undefined,
      once = false,
    ) => {
      const id = nextCallbackId;
      nextCallbackId += 1;
      callbacks.set(id, (data) => {
        if (once) {
          callbacks.delete(id);
        }
        return callback?.(data);
      });
      return id;
    },
    unregisterCallback: (id: number) => callbacks.delete(id),
  });
};

/**
 * Installs the Tauri IPC boundary (`__TAURI_INTERNALS__` and the event
 * plugin) before the page loads, answering commands with `handlers`.
 */
export const installTauriIpc = async <Arg>(
  page: Page,
  { arg, handlers, unhandled, windowLabel }: InstallTauriIpcOptions<Arg>,
) => {
  const config = {
    commands: DESKTOP_COMMANDS,
    global: IPC_GLOBAL,
    unhandled,
    windowLabel,
  } satisfies PageConfig;
  await page.addInitScript({
    content: `(${installInPage.toString()})(${handlers.toString()}, ${JSON.stringify(arg)}, ${JSON.stringify(config)});`,
  });
};

const isInvocation = (value: unknown): value is TauriInvocation =>
  typeof value === "object" &&
  value !== null &&
  "args" in value &&
  typeof value.args === "object" &&
  value.args !== null &&
  "command" in value &&
  typeof value.command === "string";

/** The native calls the page has made so far, in call order. */
export const tauriInvocations = async (
  page: Page,
): Promise<TauriInvocation[]> => {
  const invocations = await page.evaluate((global): unknown => {
    const ipc: unknown = Reflect.get(window, global);
    return typeof ipc === "object" && ipc !== null
      ? Reflect.get(ipc, "invocations")
      : undefined;
  }, IPC_GLOBAL);
  if (!Array.isArray(invocations) || !invocations.every(isInvocation)) {
    throw new TypeError("The Tauri invocation log is not installed");
  }
  return invocations;
};

/** Calls the handlers refused, for an `afterEach` to assert empty. */
export const unexpectedTauriCalls = async (page: Page): Promise<string[]> => {
  const unexpected = await page.evaluate((global): unknown => {
    const ipc: unknown = Reflect.get(window, global);
    return typeof ipc === "object" && ipc !== null
      ? Reflect.get(ipc, "unexpected")
      : undefined;
  }, IPC_GLOBAL);
  if (
    !Array.isArray(unexpected) ||
    !unexpected.every((call) => typeof call === "string")
  ) {
    throw new TypeError("The Tauri unexpected-call log is not installed");
  }
  return unexpected;
};

/** Emits a native event to the page's live listeners. */
export const emitTauriEvent = async (
  page: Page,
  event: string,
  payload: unknown = null,
) => {
  await page.evaluate(
    ({ global, name, data }) => {
      const ipc: unknown = Reflect.get(window, global);
      const emit: unknown =
        typeof ipc === "object" && ipc !== null
          ? Reflect.get(ipc, "emit")
          : undefined;
      const isEmitter = (value: unknown): value is TauriPageIpc["emit"] =>
        typeof value === "function";
      if (!isEmitter(emit)) {
        throw new TypeError("The Tauri IPC boundary is not installed");
      }
      emit(name, data);
    },
    { global: IPC_GLOBAL, name: event, data: payload },
  );
};
