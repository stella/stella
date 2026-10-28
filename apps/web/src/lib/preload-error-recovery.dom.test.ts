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
  test("offline failure does not reload or swallow the preload rejection", async () => {
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
    await Promise.resolve();

    expect(event.defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(await recoverFromStaleDeploymentLoad(CHUNK_ERROR)).toEqual({
      type: "not-skew",
    });
  });

  test("same-build failure does not reload", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ commit: "running-build" })),
    );
    const reload = spyOn(window.location, "reload").mockImplementation(
      () => undefined,
    );

    expect(await recoverFromStaleDeploymentLoad(CHUNK_ERROR)).toEqual({
      type: "not-skew",
    });
    expect(reload).not.toHaveBeenCalled();
  });

  test("confirmed build skew reloads once", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ commit: "new-build" })),
    );
    const reload = spyOn(window.location, "reload").mockImplementation(
      () => undefined,
    );

    expect(await recoverFromStaleDeploymentLoad(CHUNK_ERROR)).toEqual({
      type: "build-skew",
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("confirmed skew with the reload guard set becomes not-skew", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ commit: "new-build" })),
    );
    browserStorage("session")?.setItem(
      "stella:preload-reload-at",
      String(Date.now()),
    );
    const reload = spyOn(window.location, "reload").mockImplementation(
      () => undefined,
    );

    expect(await recoverFromStaleDeploymentLoad(CHUNK_ERROR)).toEqual({
      type: "not-skew",
    });
    expect(reload).not.toHaveBeenCalled();
  });

  test("probe failure is not build skew", async () => {
    spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    expect(await classifyFailedChunkLoad()).toEqual({ type: "not-skew" });
  });

  test("the Vite listener leaves unrelated import failures for the route boundary", () => {
    installPreloadErrorRecovery();
    const event = Object.assign(
      new Event("vite:preloadError", { cancelable: true }),
      { payload: new Error("route module evaluation failed") },
    );
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
