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
      type: "offline",
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

    expect(await recoverFromStaleDeploymentLoad(CHUNK_ERROR)).toEqual({
      type: "build-skew",
    });
    expect(await recoverFromStaleDeploymentLoad(CHUNK_ERROR)).toEqual({
      type: "build-skew",
    });
    expect(reload).toHaveBeenCalledTimes(1);
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
