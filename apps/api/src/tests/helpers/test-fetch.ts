import { panic } from "better-result";
import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";

// Captured by the preload before asynchronous test modules install request fakes.
export const testFetch = globalThis.fetch;

/** A scoped replacement; restoring one owner must not conceal another owner's leak. */
export const installTestFetch = (replacement: typeof fetch) => {
  let previous = globalThis.fetch;
  globalThis.fetch = replacement;
  return {
    install: () => {
      if (globalThis.fetch === replacement) {
        return;
      }
      previous = globalThis.fetch;
      globalThis.fetch = replacement;
    },
    restore: () => {
      if (globalThis.fetch === replacement) {
        globalThis.fetch = previous;
      }
    },
  };
};

type FetchInstallation = ReturnType<typeof installTestFetch>;
type FetchSuite = { replacement?: typeof fetch };

/** Register in the consuming test file, so its teardown precedes the fetch guard. */
export const createTestFetch = () => {
  const installations: FetchInstallation[] = [];
  const suites: FetchSuite[] = [];
  let fileReplacement: typeof fetch | undefined;
  let phase:
    | { type: "registration" }
    | { type: "suite"; suite: FetchSuite }
    | { type: "test" }
    | { type: "closed" } = { type: "registration" };
  const restore = () => {
    for (const installation of installations.toReversed()) {
      installation.restore();
    }
    installations.length = 0;
  };
  const install = (replacement: typeof fetch) => {
    const installation = installTestFetch(replacement);
    installations.push(installation);
  };
  beforeEach(() => {
    restore();
    phase = { type: "test" };
    const replacement =
      suites.findLast((suite) => suite.replacement !== undefined)
        ?.replacement ?? fileReplacement;
    if (replacement !== undefined) {
      install(replacement);
    }
  });
  afterEach(restore);
  afterAll(() => {
    restore();
    phase = { type: "closed" };
  });
  return {
    set: <Replacement extends typeof fetch>(
      replacement: Replacement,
    ): Replacement => {
      switch (phase.type) {
        case "registration":
          fileReplacement = replacement;
          break;
        case "suite":
          phase.suite.replacement = replacement;
          install(replacement);
          break;
        case "test":
          install(replacement);
          break;
        case "closed":
          panic(
            "Test fetch fixture is closed; register it in the consuming test file",
          );
      }
      return replacement;
    },
    restore,
    beforeAll: (setup: () => void | Promise<void>, timeout?: number) => {
      const suite: FetchSuite = {};
      beforeAll(async () => {
        restore();
        suites.push(suite);
        phase = { type: "suite", suite };
        try {
          await setup();
        } finally {
          restore();
          phase = { type: "test" };
        }
      }, timeout);
      afterAll(() => {
        restore();
        const index = suites.indexOf(suite);
        if (index !== -1) {
          suites.splice(index, 1);
        }
      });
    },
  };
};

export const withTestFetch = async <T>(
  replacement: typeof fetch,
  operation: () => Promise<T>,
): Promise<T> => {
  const installation = installTestFetch(replacement);
  try {
    return await operation();
  } finally {
    installation.restore();
  }
};

/** Intercept replacements made by nested fixture builders, restoring the descriptor too. */
export const withTestFetchInterceptor = async <T>(
  intercept: (
    input: Parameters<typeof fetch>[0],
    init: RequestInit | undefined,
    delegate: typeof fetch,
  ) => Promise<Response>,
  operation: () => Promise<T>,
): Promise<T> => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const original = globalThis.fetch;
  let delegate = original;
  const wrapper = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      await intercept(input, init, delegate),
    { preconnect: original.preconnect },
  );
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    get: () => wrapper,
    set: (replacement: typeof fetch) => {
      delegate = replacement;
    },
  });
  try {
    return await operation();
  } finally {
    if (descriptor === undefined) {
      Reflect.deleteProperty(globalThis, "fetch");
    } else {
      Object.defineProperty(globalThis, "fetch", descriptor);
    }
  }
};
