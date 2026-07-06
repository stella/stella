import { afterEach, setDefaultTimeout } from "bun:test";

import { awaitSandboxAdmissionIdle } from "@/api/handlers/chat/tools/execute/sandbox/run-sandbox";

/**
 * The sandbox admission state (`activeSandboxCount`, the admission queue, and
 * the in-flight host-work set) lives at module scope, and Bun runs a package's
 * test files in ONE shared process. So any test file that drives the real
 * sandbox must drain that state after every test; otherwise one test's
 * background host work (or a run that outlives its assertions) bleeds into the
 * timing of the next test — and, in the worst case, a stranded host promise
 * hangs every later test for the full per-test timeout.
 *
 * This is the single seam every sandbox test file wires in, so the hygiene
 * cannot be forgotten per-file and cannot drift between files. It sets the
 * shared 15s ceiling (real QuickJS runs need headroom over Bun's 5s default)
 * and registers the bounded `afterEach` drain.
 */
export const registerSandboxTestHygiene = (): void => {
  // Real QuickJS runs (and their wall-clock deadline) need more than Bun's
  // default 5s per-test ceiling.
  setDefaultTimeout(15_000);

  afterEach(async () => {
    await awaitSandboxAdmissionIdle();
  });
};
