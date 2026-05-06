/** Guest-visible name of the QuickJS function the host registers before prelude runs. */
export const SANDBOX_HOST_BRIDGE_GLOBAL = "__readCall" as const;

/** Guest global exposing readonly data functions as `read.<name>(input)`. */
export const SANDBOX_READ_GLOBAL = "read" as const;

/** Local alias in emitted prelude for the captured bridge function. */
export const SANDBOX_BRIDGE_LOCAL_ALIAS = "__readBridge" as const;

export const SANDBOX_BLOCKED_GLOBALS = [
  "require",
  "process",
  "fetch",
  "XMLHttpRequest",
] as const;

export const SANDBOX_CONSOLE_METHODS = [
  "log",
  "warn",
  "error",
  "info",
  "debug",
] as const;

/** Property names the `read` proxy must not expose so `read` is not a thenable. */
export const SANDBOX_THENABLE_PROPERTY_NAMES = [
  "then",
  "catch",
  "finally",
] as const;

/**
 * JavaScript run before the transpiled sandbox body. Must stay aligned with
 * host registration using {@link SANDBOX_HOST_BRIDGE_GLOBAL}.
 */
export const buildHostBridgePrelude = (): string => {
  const thenableGuard = SANDBOX_THENABLE_PROPERTY_NAMES.map(
    (n) => `name === "${n}"`,
  ).join(" || ");

  const consoleBody = SANDBOX_CONSOLE_METHODS.map(
    (method) => `    ${method}: () => {},`,
  ).join("\n");

  const blockedDeletes = SANDBOX_BLOCKED_GLOBALS.map(
    (name) => `  delete globalThis.${name};`,
  ).join("\n");

  return `
  const ${SANDBOX_BRIDGE_LOCAL_ALIAS} = globalThis.${SANDBOX_HOST_BRIDGE_GLOBAL};
  delete globalThis.${SANDBOX_HOST_BRIDGE_GLOBAL};
  globalThis.console = {
${consoleBody}
  };
${blockedDeletes}
  globalThis.${SANDBOX_READ_GLOBAL} = new Proxy(Object.create(null), {
    get(_target, name) {
      if (typeof name !== "string") return undefined;
      if (${thenableGuard}) {
        return undefined;
      }
      return (input) => {
        const argsJson = JSON.stringify(input ?? {});
        const promise = ${SANDBOX_BRIDGE_LOCAL_ALIAS}(name, argsJson);
        return promise.then((resultJson) => {
          if (resultJson === undefined || resultJson === null) return undefined;
          return JSON.parse(resultJson);
        });
      };
    },
  });
`;
};
