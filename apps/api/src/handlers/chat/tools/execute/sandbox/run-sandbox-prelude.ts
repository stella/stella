/** Guest-visible name of the QuickJS function the host registers before prelude runs. */
export const SANDBOX_HOST_BRIDGE_GLOBAL = "__readCall" as const;

/** Guest global exposing readonly data functions as `read.<name>(input)`. */
export const SANDBOX_READ_GLOBAL = "read" as const;

/** Local alias in emitted prelude for the captured bridge function. */
export const SANDBOX_BRIDGE_LOCAL_ALIAS = "__readBridge" as const;

/** Guest-visible name of the QuickJS console sink the host registers before prelude runs. */
export const SANDBOX_CONSOLE_BRIDGE_GLOBAL = "__consoleCall" as const;

/** Local alias in emitted prelude for the captured console sink. */
export const SANDBOX_CONSOLE_LOCAL_ALIAS = "__consoleBridge" as const;

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

/**
 * Guest-visible name of the synchronous QuickJS function that answers what a
 * guided name stands for (see {@link buildNameGuidePrelude}).
 */
export const SANDBOX_NAME_GUIDE_BRIDGE_GLOBAL = "__nameGuideCall" as const;

/** Local alias in emitted prelude for the captured name-guide bridge. */
const SANDBOX_NAME_GUIDE_LOCAL_ALIAS = "__nameGuideBridge" as const;

/**
 * `name` of the error a guided name throws when it stands for no script
 * function. The host maps it onto the `not-a-script-function` reason.
 */
export const SANDBOX_NAME_GUIDE_ERROR_NAME =
  "SandboxNotAScriptFunction" as const;

/** A name the guest can declare as a global binding. */
export const SANDBOX_IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/u;

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
    (method) =>
      `    ${method}: (...args) => { ${SANDBOX_CONSOLE_LOCAL_ALIAS}("${method}", __formatConsoleArgs(args)); },`,
  ).join("\n");

  const blockedDeletes = SANDBOX_BLOCKED_GLOBALS.map(
    (name) => `  delete globalThis.${name};`,
  ).join("\n");

  return `
  const ${SANDBOX_BRIDGE_LOCAL_ALIAS} = globalThis.${SANDBOX_HOST_BRIDGE_GLOBAL};
  delete globalThis.${SANDBOX_HOST_BRIDGE_GLOBAL};
  const ${SANDBOX_CONSOLE_LOCAL_ALIAS} = globalThis.${SANDBOX_CONSOLE_BRIDGE_GLOBAL};
  delete globalThis.${SANDBOX_CONSOLE_BRIDGE_GLOBAL};
  const __formatConsoleArgs = (args) =>
    args
      .map((arg) => {
        if (typeof arg === "string") return arg;
        try {
          const json = JSON.stringify(arg);
          return json === undefined ? String(arg) : json;
        } catch (error) {
          return String(arg);
        }
      })
      .join(" ");
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

/**
 * JavaScript run after {@link buildHostBridgePrelude} when the host guides
 * names. Each name becomes a global function unless the global already
 * exists, so a script's own declaration of the name still shadows it. Calling
 * one asks the host (synchronously) what the name stands for: a read function
 * to run through the same `read` bridge every script call uses, or a message
 * explaining the call to make instead, thrown as the guided error. A name the
 * host no longer recognizes throws the ReferenceError the script would have
 * got without the guide.
 */
export const buildNameGuidePrelude = (names: readonly string[]): string => {
  const guided = names.filter((name) => SANDBOX_IDENTIFIER_PATTERN.test(name));
  if (guided.length === 0) {
    return "";
  }
  return `
  const ${SANDBOX_NAME_GUIDE_LOCAL_ALIAS} = globalThis.${SANDBOX_NAME_GUIDE_BRIDGE_GLOBAL};
  delete globalThis.${SANDBOX_NAME_GUIDE_BRIDGE_GLOBAL};
  const __guideRead = globalThis.${SANDBOX_READ_GLOBAL};
  for (const __guidedName of ${JSON.stringify(guided)}) {
    if (__guidedName in globalThis) continue;
    Object.defineProperty(globalThis, __guidedName, {
      configurable: true,
      writable: true,
      value: (input) => {
        const verdict = JSON.parse(${SANDBOX_NAME_GUIDE_LOCAL_ALIAS}(__guidedName));
        if (typeof verdict.run === "string") {
          return __guideRead[verdict.run](input);
        }
        if (typeof verdict.explain === "string") {
          const error = new Error(verdict.explain);
          error.name = "${SANDBOX_NAME_GUIDE_ERROR_NAME}";
          throw error;
        }
        throw new ReferenceError(__guidedName + " is not defined");
      },
    });
  }
`;
};
