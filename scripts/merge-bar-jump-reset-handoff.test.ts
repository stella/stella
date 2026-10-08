import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { armAndVerify } from "./merge-bar";
import { createJumpResetStore, JumpResetError } from "./merge-bar-jump-reset";

const HEAD = "a".repeat(40);
const initial = {
  id: "PR_fixture",
  headRefOid: HEAD,
  updatedAt: "2026-10-07T10:00:00Z",
  autoMergeRequest: null,
  mergeQueueEntry: null,
};

test.each([
  "accepted",
  "verification-failure",
  "jump-false",
  "missing-flag",
  "mutation-failure",
  "already-queued",
])("records accepted jumps before verification: %s", (scenario) => {
  const directory = mkdtempSync(path.join(tmpdir(), "jump-handoff-"));
  try {
    const store = createJumpResetStore(directory);
    let reads = 0;
    let writes = 0;
    let reserved = false;
    let mutationStarted = 0;
    let responseAt = 0;
    const receipt = {
      position: 2,
      state: "QUEUED",
      ...(scenario === "missing-flag"
        ? {}
        : { jump: scenario !== "jump-false" }),
    };
    const result = armAndVerify({
      pullRequestId: initial.id,
      expectedHeadSha: HEAD,
      jump: true,
      checksSucceeded: true,
      readRemovals: () => [],
      readState: () => {
        reads += 1;
        if (reads > 1) {
          const jumps = store.readJumps();
          expect(jumps.isOk()).toBe(true);
          if (jumps.isOk()) {
            expect(jumps.value.length).toBe(
              scenario === "accepted" || scenario === "verification-failure"
                ? 1
                : 0,
            );
          }
          if (scenario === "verification-failure") {
            throw new JumpResetError({ message: "verification unavailable" });
          }
        }
        return scenario === "already-queued" || reads > 1
          ? { ...initial, mergeQueueEntry: { id: "entry", ...receipt } }
          : initial;
      },
      beforeWrite: () => {
        reserved = true;
      },
      mutate: (_query, variables) => {
        expect(reserved).toBe(true);
        expect(variables.sha).toBe(HEAD);
        writes += 1;
        mutationStarted = Date.now();
        Bun.sleepSync(5);
        responseAt = Date.now();
        if (scenario === "mutation-failure") {
          throw new JumpResetError({ message: "mutation outcome unknown" });
        }
        return { data: { enqueuePullRequest: { mergeQueueEntry: receipt } } };
      },
      onJumpAccepted: (at) => {
        expect(Date.parse(at)).toBeLessThanOrEqual(mutationStarted);
        expect(Date.parse(at)).toBeLessThan(responseAt);
        const recorded = store.recordJump({
          repo: "stella/stella",
          pr: 123,
          head: HEAD,
          at,
        });
        expect(recorded.isOk()).toBe(true);
      },
    });
    expect(result.isErr()).toBe(
      scenario === "mutation-failure" ||
        scenario === "verification-failure" ||
        scenario === "missing-flag",
    );
    expect(writes).toBe(scenario === "already-queued" ? 0 : 1);
    const records = store.readJumps();
    expect(records.isOk()).toBe(true);
    if (records.isOk()) {
      expect(records.value).toHaveLength(
        scenario === "accepted" || scenario === "verification-failure" ? 1 : 0,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unknown mutation preserves the reservation and a restart refuses another write", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "jump-reserve-handoff-"));
  try {
    const key = `stella/stella#123@${HEAD}`;
    let writes = 0;
    const run = () => {
      const store = createJumpResetStore(directory);
      return armAndVerify({
        pullRequestId: initial.id,
        expectedHeadSha: HEAD,
        jump: false,
        checksSucceeded: true,
        readState: () => initial,
        readRemovals: () => [],
        beforeWrite: () => {
          const reservation = store.reserve(key);
          if (reservation.isErr()) {
            throw reservation.error;
          }
        },
        mutate: () => {
          writes += 1;
          throw new JumpResetError({ message: "mutation outcome unknown" });
        },
      });
    };
    expect(run().isErr()).toBe(true);
    expect(run().isErr()).toBe(true);
    expect(writes).toBe(1);
    const records = createJumpResetStore(directory).readJumps();
    expect(records.isOk()).toBe(true);
    if (records.isOk()) {
      expect(records.value).toEqual([]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
