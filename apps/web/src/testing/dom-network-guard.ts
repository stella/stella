import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { DetachedWindowAPI } from "happy-dom";
import http from "node:http";
import https from "node:https";

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
 *
 * The test preload installs the guard and owns the test lifecycle hooks that
 * mark tests and report refusals.
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

const httpRequest = http.request;
const httpGet = http.get;
const httpsRequest = https.request;
const httpsGet = https.get;

const refuseNetwork = (refuse: boolean) => {
  Object.defineProperty(http, "request", {
    value: refuse ? refuseRequest : httpRequest,
  });
  Object.defineProperty(http, "get", {
    value: refuse ? refuseRequest : httpGet,
  });
  Object.defineProperty(https, "request", {
    value: refuse ? refuseRequest : httpsRequest,
  });
  Object.defineProperty(https, "get", {
    value: refuse ? refuseRequest : httpsGet,
  });
};

/** Attributes refusals from now on to the running test. */
export const markTestStarted = () => {
  testRunning = true;
};

/** Attributes refusals from now on to work outside any test. */
export const markTestEnded = () => {
  testRunning = false;
};

/**
 * Hands over the refusals recorded so far and forgets them, so the global
 * hooks no longer fail the test for them. Only the guard's own regression
 * test takes them: it provokes refusals on purpose and asserts on the record.
 */
export const takeRefusedRequests = (): readonly string[] =>
  unmockedRequests.splice(0);

/** Fails with every refusal recorded since the last report, if any. */
export const reportRefusedRequests = () => {
  const requests = takeRefusedRequests();
  if (requests.length === 0) {
    return;
  }
  panic(
    `Unmocked network request(s), refused by the DOM test preload:\n${requests.map((request) => `  - ${request}`).join("\n")}`,
  );
};

/**
 * Refuses the network for as long as the DOM is registered.
 *
 * No timer, animation frame, microtask or request a DOM test scheduled may
 * run once the DOM is gone either. `GlobalRegistrator.unregister` deletes the
 * window globals first and only then closes the window, so a callback landing
 * in between (React's scheduler, a transition, a debounce) runs without
 * `window` and fails the run as an unhandled error after the last test. Every
 * DOM test tears down through `unregister`, so it first cancels that work and
 * drains pending microtasks while the window still exists.
 */
export const installDomNetworkGuard = () => {
  const registerHappyDom = GlobalRegistrator.register.bind(GlobalRegistrator);
  const unregisterHappyDom =
    GlobalRegistrator.unregister.bind(GlobalRegistrator);
  Object.defineProperties(GlobalRegistrator, {
    register: {
      value: (...options: Parameters<typeof registerHappyDom>) => {
        registerHappyDom(...options);
        refuseNetwork(true);
      },
    },
    unregister: {
      value: async () => {
        const happyDom: unknown = Object.getOwnPropertyDescriptor(
          globalThis,
          "happyDOM",
        )?.value;
        if (happyDom instanceof DetachedWindowAPI) {
          await happyDom.abort();
        }
        refuseNetwork(false);
        await unregisterHappyDom();
      },
    },
  });
};
