import { afterAll, afterEach, beforeEach } from "bun:test";

import { reactCompilerBunPlugin } from "@stll/scripts/src/react-compiler-bun-plugin";

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

// Tests run the program that ships: compiled by the React Compiler, as the
// Vite build compiles it. Components leave memoization to the compiler, so an
// uncompiled render would loop or re-render where the app does not. The
// first plugin whose filter matches a module loads it, so a test stubs a
// source module with `mock.module`, never with its own `Bun.plugin`.
Bun.plugin(reactCompilerBunPlugin);

// Tests must never inherit a developer deployment URL. A single preload owns
// this process-wide value so test files can restore it safely.
Object.assign(import.meta.env, {
  VITE_API_URL: "http://localhost:3001",
});

// DOM tests never reach a real server; a request they leave unmocked fails
// the test it happened in (see `installDomNetworkGuard`).
installDomNetworkGuard();

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
