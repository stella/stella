import { afterAll, afterEach, beforeEach } from "bun:test";

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
