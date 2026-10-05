import { describe, expect, test } from "bun:test";

import { disarmPullRequest, parseOptions } from "./merge-bar";

const state = ({ armed = false, queued = false } = {}) => ({
  id: "PR_fixture",
  headRefOid: "verified-head",
  updatedAt: "2026-10-04T18:00:00Z",
  autoMergeRequest: armed ? { enabledAt: "2026-10-04T19:00:00Z" } : null,
  mergeQueueEntry: queued ? { id: "MQ_fixture" } : null,
});

describe("holding pull requests", () => {
  test.each([
    { armed: false, queued: false },
    { armed: true, queued: false },
    { armed: false, queued: true },
    { armed: true, queued: true },
  ])("clears both independent handoffs and is idempotent: %j", (initial) => {
    let armed = initial.armed;
    let queued = initial.queued;
    const writes: string[] = [];
    const gateway = {
      readArmState: () => state({ armed, queued }),
      mutateHandoff: (query: string) => {
        writes.push(query);
        if (query.includes("disablePullRequestAutoMerge")) {
          armed = false;
        }
        if (query.includes("dequeuePullRequest")) {
          queued = false;
        }
        return {};
      },
    };
    expect(disarmPullRequest({ gateway, dryRun: false }).unwrap()).toEqual({
      status: "disarmed",
      id: "PR_fixture",
      headSha: "verified-head",
    });
    expect(armed).toBe(false);
    expect(queued).toBe(false);
    expect(writes).toHaveLength(Number(initial.armed) + Number(initial.queued));
    const writeCount = writes.length;
    expect(disarmPullRequest({ gateway, dryRun: false }).isOk()).toBe(true);
    expect(writes).toHaveLength(writeCount);
  });

  test("dequeues auto-merge that enqueues during disable", () => {
    let current = state({ armed: true });
    const result = disarmPullRequest({
      dryRun: false,
      gateway: {
        readArmState: () => current,
        mutateHandoff: (query) => {
          current = state({
            queued: query.includes("disablePullRequestAutoMerge"),
          });
          return {};
        },
      },
    });
    expect(result.isOk()).toBe(true);
    expect(current).toEqual(state());
  });

  test("dry run performs no writes", () => {
    const result = disarmPullRequest({
      dryRun: true,
      gateway: {
        readArmState: () => state({ armed: true, queued: true }),
        mutateHandoff: () => {
          throw new Error("unexpected dry-run mutation");
        },
      },
    });
    expect(result.unwrap()).toEqual({ status: "dry-run", id: "PR_fixture" });
  });

  test.each(["disablePullRequestAutoMerge", "dequeuePullRequest"])(
    "propagates a %s failure without reporting a receipt",
    (operation) => {
      const result = disarmPullRequest({
        dryRun: false,
        gateway: {
          readArmState: () =>
            state({
              armed: operation === "disablePullRequestAutoMerge",
              queued: true,
            }),
          mutateHandoff: () => {
            throw new Error(`${operation} refused`);
          },
        },
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toContain(`${operation} refused`);
      }
    },
  );

  test.each([{ armed: true }, { queued: true }])(
    "refuses an uncleared final state: %j",
    (initial) => {
      const result = disarmPullRequest({
        dryRun: false,
        gateway: {
          readArmState: () => state(initial),
          mutateHandoff: () => ({}),
        },
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toContain("Disarm verification failed");
      }
    },
  );

  test("disarm is explicit and rejects jump", () => {
    expect(
      parseOptions(["--disarm", "123", "--repo", "stella/folio"]).mode,
    ).toBe("disarm");
    expect(parseOptions(["123"]).mode).toBe("merge");
    expect(() => parseOptions(["--disarm", "123", "--jump"])).toThrow(
      "--disarm cannot be combined with --jump",
    );
  });
});
