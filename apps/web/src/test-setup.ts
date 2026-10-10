import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, beforeEach } from "bun:test";
import { DetachedWindowAPI } from "happy-dom";
import http from "node:http";
import https from "node:https";

// Tests must never inherit a developer deployment URL. A single preload owns
// this process-wide value so test files can restore it safely.
Object.assign(import.meta.env, {
  VITE_API_URL: "http://localhost:3001",
});

/**
 * No DOM test reaches a real server. happy-dom's `fetch` and `XMLHttpRequest`
 * send through Node's HTTP client, so while the DOM is registered every
 * request the code under test makes without a mock in place would hit
 * whatever listens on the API port: usually nothing, failing the run with an
 * unattributed ECONNREFUSED between tests, or worse, a developer's live
 * stack. The request is refused at once, and because callers may swallow the
 * rejection, the test it happened in fails as well, naming the URL.
 *
 * Only DOM tests are covered: unit tests may drive an in-process fake server
 * through the same client, and they never load happy-dom's transport.
 */
const unmockedRequests: string[] = [];
let testRunning = false;

const requestTarget = (target: unknown): string =>
  target instanceof URL ? target.href : String(target);

const refuseRequest = (target: unknown): never => {
  const url = requestTarget(target);
  const when = testRunning
    ? "during this test"
    : "outside a test (while loading the file or after the previous test ended)";
  unmockedRequests.push(`${url} ${when}`);
  return panic(
    `Unmocked network request to ${url}: DOM tests must not reach a real server. Mock the request (stub fetch, seed the query cache, or inject the client) or settle the work that sends it before the test ends.`,
  );
};

const httpClients = [http, https].map((transport) => ({
  transport,
  request: transport.request,
  get: transport.get,
}));

const refuseNetwork = (refuse: boolean) => {
  for (const { transport, request, get } of httpClients) {
    Object.defineProperty(transport, "request", {
      value: refuse ? refuseRequest : request,
    });
    Object.defineProperty(transport, "get", {
      value: refuse ? refuseRequest : get,
    });
  }
};

const reportUnmockedRequests = () => {
  if (unmockedRequests.length === 0) {
    return;
  }
  const requests = unmockedRequests.splice(0);
  panic(
    `Unmocked network request(s), refused by the DOM test preload:\n${requests.map((request) => `  - ${request}`).join("\n")}`,
  );
};

beforeEach(() => {
  testRunning = true;
});

afterEach(() => {
  testRunning = false;
  reportUnmockedRequests();
});

afterAll(reportUnmockedRequests);

/**
 * No timer, animation frame, microtask or request a DOM test scheduled may
 * run once the DOM is gone. `GlobalRegistrator.unregister` deletes the window
 * globals first and only then closes the window, so a callback landing in
 * between (React's scheduler, a transition, a debounce) runs without `window`
 * and fails the run as an unhandled error after the last test. Every DOM test
 * tears down through `unregister`, so it first cancels that work and drains
 * pending microtasks while the window still exists.
 */
const registerHappyDom = GlobalRegistrator.register.bind(GlobalRegistrator);
const unregisterHappyDom = GlobalRegistrator.unregister.bind(GlobalRegistrator);
Object.defineProperties(GlobalRegistrator, {
  register: {
    value: (...options: Parameters<typeof registerHappyDom>) => {
      registerHappyDom(...options);
      refuseNetwork(true);
    },
  },
  unregister: {
    value: async () => {
      const happyDom: unknown = Reflect.get(globalThis, "happyDOM");
      if (happyDom instanceof DetachedWindowAPI) {
        await happyDom.abort();
      }
      refuseNetwork(false);
      await unregisterHappyDom();
    },
  },
});
