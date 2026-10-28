import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { browserStorage } from "@/lib/account/browser-storage";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

beforeAll(() => {
  Object.defineProperty(globalThis, "__APP_COMMIT_SHA__", {
    configurable: true,
    value: "running-build",
  });
});

const {
  classifyFailedChunkLoad,
  installPreloadErrorRecovery,
  loadInitialRuntimeWithRecovery,
  recoverFromStaleDeploymentLoad,
} = await import("./preload-error-recovery");

const CHUNK_ERROR = new TypeError(
  "Failed to fetch dynamically imported module: https://example.test/chunk.js",
);

const setOnline = (online: boolean) => {
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: online,
  });
};

afterEach(() => {
  browserStorage("session")?.clear();
  setOnline(true);
  mock.restore();
});

afterAll(async () => {
  Reflect.deleteProperty(globalThis, "__APP_COMMIT_SHA__");
  await unregisterDomEnvironment();
});

describe("failed chunk recovery", () => {
  test("offline failure keeps the page and retries when the browser comes online", async () => {
    setOnline(false);
    const reload = spyOn(window.location, "reload").mockImplementation(
      () => undefined,
    );
    const retry = mock(() => undefined);

    expect(await recoverFromStaleDeploymentLoad(CHUNK_ERROR, retry)).toEqual({
      classification: { type: "offline" },
      recovery: { type: "retry-when-online" },
    });
    expect(reload).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("online"));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("confirmed build skew reloads once and the guard prevents a loop", async () => {
    const fetch = spyOn(globalThis, "fetch");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ commit: "new-build" }), { status: 200 }),
      );
    }
    const reload = spyOn(window.location, "reload").mockImplementation(
      () => undefined,
    );

    expect(
      await recoverFromStaleDeploymentLoad(CHUNK_ERROR, () => undefined),
    ).toEqual({
      classification: { type: "build-skew" },
      recovery: { type: "reload", outcome: { type: "started" } },
    });
    expect(
      await recoverFromStaleDeploymentLoad(CHUNK_ERROR, () => undefined),
    ).toEqual({
      classification: { type: "build-skew" },
      recovery: {
        type: "reload",
        outcome: { type: "refused-cooldown" },
      },
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("an online same-build failure retries immediately without waiting for an online event", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ commit: "running-build" })),
    );
    const retry = mock(() => undefined);

    expect(await recoverFromStaleDeploymentLoad(CHUNK_ERROR, retry)).toEqual({
      classification: { type: "network-error" },
      recovery: { type: "retry-now" },
    });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("online same-build startup failure exhausts bounded retries", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ commit: "running-build" })),
    );
    const load = mock(async () => {
      throw CHUNK_ERROR;
    });

    expect(
      await rejectionOf(
        loadInitialRuntimeWithRecovery({
          load,
          retryDelaysMs: [0, 0],
          wait: async () => undefined,
        }),
      ),
    ).toBe(CHUNK_ERROR);
    expect(load).toHaveBeenCalledTimes(3);
  });

  test("offline startup retries once after the browser comes online", async () => {
    setOnline(false);
    const load = mock(async () => {
      if (load.mock.calls.length === 1) {
        throw CHUNK_ERROR;
      }
    });
    const online = Promise.withResolvers<undefined>();
    const waiting = Promise.withResolvers<undefined>();
    const outcome = loadInitialRuntimeWithRecovery({
      load,
      waitUntilOnline: async () => {
        waiting.resolve(undefined);
        return online.promise;
      },
    });
    await waiting.promise;
    setOnline(true);
    online.resolve(undefined);

    expect(await outcome).toEqual({ type: "loaded" });
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("probe failure is network failure, not build skew", async () => {
    spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    expect(await classifyFailedChunkLoad()).toEqual({ type: "network-error" });
  });

  test("the Vite listener prevents a chunk rethrow without synchronously reloading", () => {
    setOnline(false);
    const reload = spyOn(window.location, "reload").mockImplementation(
      () => undefined,
    );
    installPreloadErrorRecovery();
    const event = Object.assign(
      new Event("vite:preloadError", { cancelable: true }),
      { payload: CHUNK_ERROR },
    );
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });
});
