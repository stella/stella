import { afterAll, afterEach, beforeEach, mock } from "bun:test";

import { restoreRealTimers } from "@stll/property-testing/fake-timers";

import {
  installDomNetworkGuard,
  markTestEnded,
  markTestStarted,
  reportRefusedRequests,
} from "@/testing/dom-network-guard";
import { currentTestIsomorphicHalf } from "@/testing/isomorphic-half";
import {
  installTimerGuard,
  markTimerTestEnded,
  markTimerTestStarted,
  reportLeakedTimers,
} from "@/testing/timer-guard";

// Tests must never inherit a developer deployment URL. A single preload owns
// this process-wide value so test files can restore it safely.
Object.assign(import.meta.env, {
  VITE_API_URL: "http://localhost:3001",
});

// DOM tests never reach a real server; a request they leave unmocked fails
// the test it happened in (see `installDomNetworkGuard`).
installDomNetworkGuard();

// Bun does not run Start's build transform. DOM tests select the browser half
// by default; a server fixture can select the server half inside a real request.
// The stubs package (behind `@tanstack/react-start`) is replaced whole, so the
// preload loads nothing; its env-only helpers are identity functions.
type IsomorphicHalf = (...args: never[]) => unknown;
await mock.module("@tanstack/start-fn-stubs", () => ({
  createClientOnlyFn: <Fn>(fn: Fn) => fn,
  createServerOnlyFn: <Fn>(fn: Fn) => fn,
  createIsomorphicFn: () => {
    let clientHalf: IsomorphicHalf | undefined;
    let serverHalf: IsomorphicHalf | undefined;
    const isomorphic = Object.assign(
      (...args: never[]) => {
        const half =
          currentTestIsomorphicHalf() === "server" ? serverHalf : clientHalf;
        return half?.(...args);
      },
      {
        server: (half: IsomorphicHalf) => {
          serverHalf = half;
          return isomorphic;
        },
        client: (half: IsomorphicHalf) => {
          clientHalf = half;
          return isomorphic;
        },
      },
    );
    return isomorphic;
  },
}));

// A timer a test starts never outlives it (see `installTimerGuard`).
installTimerGuard();

beforeEach(() => {
  markTestStarted();
  markTimerTestStarted();
});

afterEach(() => {
  markTestEnded();
  markTimerTestEnded();
  // After the guard has cancelled the test's own leaked timers, so the drain
  // fires only what libraries left on a fake clock (see `restoreRealTimers`).
  restoreRealTimers();
  reportRefusedRequests();
  reportLeakedTimers();
});

afterAll(() => {
  reportRefusedRequests();
  reportLeakedTimers();
});
