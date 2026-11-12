import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  afterCommit,
  withDeferredCommitEffects,
} from "@/api/lib/idempotency/commit-effects";

describe("commit effects", () => {
  test("outside a deferred transaction an effect runs at once", () => {
    const ran: string[] = [];
    afterCommit(() => ran.push("notify"));
    expect(ran).toEqual(["notify"]);
  });

  test("inside a deferred transaction effects wait for its commit, in order", async () => {
    const ran: string[] = [];
    const value = await withDeferredCommitEffects(
      async () => {
        afterCommit(() => ran.push("notify"));
        await Promise.resolve();
        afterCommit(() => ran.push("flush"));
        expect(ran).toEqual([]);
        return "written";
      },
      () => true,
    );
    expect(value).toBe("written");
    expect(ran).toEqual(["notify", "flush"]);
  });

  test("a transaction that does not commit drops its effects", async () => {
    const ran: string[] = [];
    await withDeferredCommitEffects(
      async () => {
        afterCommit(() => ran.push("notify"));
        return await Promise.resolve("refused");
      },
      () => false,
    );
    const rejection = await rejectionOf(
      withDeferredCommitEffects(
        async () => {
          afterCommit(() => ran.push("notify"));
          await Promise.resolve();
          return panic("rolled back");
        },
        () => true,
      ),
    );
    expect(rejection).toBeInstanceOf(Error);
    expect(ran).toEqual([]);
  });

  test("detached work that outlives a dropped transaction cannot revive its effects", async () => {
    const ran: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let late: Promise<void> | undefined;
    await withDeferredCommitEffects(
      async () => {
        late = gate.then(() => afterCommit(() => ran.push("late")));
        return await Promise.resolve();
      },
      () => false,
    );
    release();
    await late;
    expect(ran).toEqual([]);
  });
});
