import { describe, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

import {
  type AdmissionClass,
  createPublicCorpusAdmission,
} from "./public-corpus-admission";

const createAdmission = ({
  classCapacity = 2,
  totalCapacity = 2,
  maxWaiters = 8,
}: {
  classCapacity?: number;
  totalCapacity?: number;
  maxWaiters?: number;
} = {}) =>
  createPublicCorpusAdmission({
    capacityOf: () => classCapacity,
    totalCapacity,
    maxWaiters,
  });

const ask = async (
  admission: ReturnType<typeof createAdmission>,
  client: string,
  {
    routeClass = "search",
    waitMs = 1000,
    signal = new AbortController().signal,
  }: {
    routeClass?: AdmissionClass;
    waitMs?: number;
    signal?: AbortSignal;
  } = {},
) => await admission.acquire({ routeClass, client, waitMs, signal });

const settled = async <T>(promise: Promise<T>) => {
  const marker = Symbol("pending");
  const result = await Promise.race([promise, sleep(5).then(() => marker)]);
  return result === marker ? "pending" : result;
};

describe("public corpus admission", () => {
  test("a waiting request is admitted when a slot is released", async () => {
    const admission = createAdmission({ classCapacity: 1, totalCapacity: 1 });
    const first = await ask(admission, "a");
    expect(first).not.toBeNull();
    const second = ask(admission, "b");
    expect(await settled(second)).toBe("pending");
    first?.();
    expect(await second).toBeInstanceOf(Function);
  });

  test("one client's search and facets queue behind each other instead of failing", async () => {
    const admission = createAdmission({ classCapacity: 1, totalCapacity: 1 });
    const search = await ask(admission, "page");
    const facets = ask(admission, "page", { routeClass: "aggregate" });
    expect(await settled(facets)).toBe("pending");
    search?.();
    expect(await facets).toBeInstanceOf(Function);
  });

  test("a client holds at most one slot per class while others get theirs", async () => {
    const admission = createAdmission({ classCapacity: 2, totalCapacity: 2 });
    const crawlerFirst = await ask(admission, "crawler");
    const crawlerSecond = ask(admission, "crawler");
    expect(await settled(crawlerSecond)).toBe("pending");
    // The free slot goes to the next client, not to the crawler's second request.
    expect(await ask(admission, "reader", { waitMs: 0 })).not.toBeNull();
    crawlerFirst?.();
    expect(await crawlerSecond).toBeInstanceOf(Function);
  });

  test("waiters are admitted in arrival order when they fit", async () => {
    const admission = createAdmission({ classCapacity: 1, totalCapacity: 1 });
    const holder = await ask(admission, "holder");
    const order: string[] = [];
    const waiters = ["x", "y", "z"].map(async (client) => {
      const lease = await ask(admission, client);
      order.push(client);
      return lease;
    });
    holder?.();
    for (const waiter of waiters) {
      (await waiter)?.();
    }
    expect(order).toEqual(["x", "y", "z"]);
  });

  test("the wait deadline refuses and leaves no slot or queue entry behind", async () => {
    const admission = createAdmission({ classCapacity: 1, totalCapacity: 1 });
    const holder = await ask(admission, "a");
    expect(await ask(admission, "b", { waitMs: 5 })).toBeNull();
    holder?.();
    expect(await ask(admission, "c", { waitMs: 0 })).not.toBeNull();
  });

  test("zero wait refuses at once when no slot is free", async () => {
    const admission = createAdmission({ classCapacity: 1, totalCapacity: 1 });
    await ask(admission, "a");
    expect(await settled(ask(admission, "b", { waitMs: 0 }))).toBeNull();
  });

  test("an abort while waiting refuses and frees the queue entry", async () => {
    const admission = createAdmission({
      classCapacity: 1,
      totalCapacity: 1,
      maxWaiters: 1,
    });
    const holder = await ask(admission, "a");
    const cancellation = new AbortController();
    const aborted = ask(admission, "b", { signal: cancellation.signal });
    cancellation.abort();
    expect(await aborted).toBeNull();
    // The queue has room again, and the aborted request never takes the slot.
    const next = ask(admission, "c");
    holder?.();
    expect(await next).toBeInstanceOf(Function);
  });

  test("an already aborted request is refused without waiting", async () => {
    const admission = createAdmission();
    const cancellation = new AbortController();
    cancellation.abort();
    expect(
      await ask(admission, "a", { signal: cancellation.signal }),
    ).toBeNull();
  });

  test("a full queue refuses at once", async () => {
    const admission = createAdmission({
      classCapacity: 1,
      totalCapacity: 1,
      maxWaiters: 1,
    });
    await ask(admission, "a");
    const queued = ask(admission, "b");
    expect(await settled(ask(admission, "c"))).toBeNull();
    expect(await settled(queued)).toBe("pending");
  });

  test("the total cap binds across classes", async () => {
    const admission = createAdmission({ classCapacity: 2, totalCapacity: 1 });
    await ask(admission, "a");
    expect(
      await ask(admission, "b", { routeClass: "aggregate", waitMs: 0 }),
    ).toBeNull();
  });

  test("releasing a lease twice frees one slot only", async () => {
    const admission = createAdmission({ classCapacity: 1, totalCapacity: 1 });
    const holder = await ask(admission, "a");
    holder?.();
    holder?.();
    expect(await ask(admission, "b", { waitMs: 0 })).not.toBeNull();
    expect(await ask(admission, "c", { waitMs: 0 })).toBeNull();
  });
});
