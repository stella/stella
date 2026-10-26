import { afterAll, afterEach, beforeAll, beforeEach, mock } from "bun:test";

import { DEFAULT_WAIT_TIMEOUT_MS } from "@stll/test-kit";

import {
  installDomNetworkGuard,
  markTestEnded,
  markTestStarted,
  reportRefusedRequests,
} from "@/testing/dom-network-guard";
import {
  installTimerGuard,
  markTimerTestEnded,
  markTimerTestStarted,
  reportLeakedTimers,
} from "@/testing/timer-guard";

beforeAll(async () => {
  // This is a hang guard, not a speed assertion. DOM test files install their
  // document at module scope, before hooks run and Testing Library is loaded.
  const { configure } = await import("@testing-library/dom");
  configure({ asyncUtilTimeout: DEFAULT_WAIT_TIMEOUT_MS });
});

// Tests must never inherit a developer deployment URL. A single preload owns
// this process-wide value so test files can restore it safely.
Object.assign(import.meta.env, {
  VITE_API_URL: "http://localhost:3001",
});

// DOM tests never reach a real server; a request they leave unmocked fails
// the test it happened in (see `installDomNetworkGuard`).
installDomNetworkGuard();

// Bun does not run Start's build transform, which keeps only the browser half
// of an isomorphic function in the client bundle. Without it the server half
// would run outside any request, so tests get the browser half, as users do.
// The stubs package (behind `@tanstack/react-start`) is replaced whole, so the
// preload loads nothing; its env-only helpers are identity functions.
type IsomorphicHalf = (...args: never[]) => unknown;
await mock.module("@tanstack/start-fn-stubs", () => ({
  createClientOnlyFn: <Fn>(fn: Fn) => fn,
  createServerOnlyFn: <Fn>(fn: Fn) => fn,
  createIsomorphicFn: () => {
    let clientHalf: IsomorphicHalf = () => undefined;
    const isomorphic = Object.assign(
      (...args: never[]) => clientHalf(...args),
      {
        server: () => isomorphic,
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
  reportRefusedRequests();
  reportLeakedTimers();
});

afterAll(() => {
  reportRefusedRequests();
  reportLeakedTimers();
});
