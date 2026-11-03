import { panic, TaggedError } from "better-result";
import { expect, spyOn, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { createCoalescedDrain } from "./coalesced-drain";

type Deferred = ReturnType<typeof Promise.withResolvers<undefined>>;

const controlledDrain = () => {
  const starts = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<Deferred>>
  >();
  const startAt = (index: number) => {
    const existing = starts.get(index);
    if (existing !== undefined) {
      return existing;
    }
    const started = Promise.withResolvers<Deferred>();
    starts.set(index, started);
    return started;
  };
  let count = 0;
  let active = 0;
  let maximumActive = 0;
  return {
    run: async () => {
      const release = Promise.withResolvers<undefined>();
      const index = count;
      count += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      startAt(index).resolve(release);
      try {
        await release.promise;
      } finally {
        active -= 1;
      }
    },
    started: async (index: number) => await startAt(index).promise,
    count: () => count,
    maximumActive: () => maximumActive,
  };
};

class DrainFailure extends TaggedError("DrainFailure")<{
  message: string;
}> {}

test("a blocked drain coalesces a thousand requests into one pending ticket", async () => {
  const work = controlledDrain();
  const request = createCoalescedDrain(work.run);
  const running = request();
  const first = await work.started(0);
  const pending = request();
  expect(pending).not.toBe(running);
  for (let index = 0; index < 1000; index += 1) {
    expect(request()).toBe(pending);
  }
  expect(work.count()).toBe(1);
  first.resolve(undefined);
  await running.completion;
  const second = await work.started(1);
  expect(work.count()).toBe(2);
  second.resolve(undefined);
  await pending.completion;
  expect(work.count()).toBe(2);
  expect(work.maximumActive()).toBe(1);
});

test("a pending ticket settles independently of later blocked work", async () => {
  const work = controlledDrain();
  const request = createCoalescedDrain(work.run);
  const firstTicket = request();
  const first = await work.started(0);
  const secondTicket = request();
  expect(request()).toBe(secondTicket);
  first.resolve(undefined);
  await firstTicket.completion;
  const second = await work.started(1);
  const thirdTicket = request();
  expect(thirdTicket).not.toBe(secondTicket);
  const settled: string[] = [];
  const thirdWaiter = thirdTicket.completion.then(() => settled.push("third"));
  second.resolve(undefined);
  await secondTicket.completion;
  const third = await work.started(2);
  expect(settled).toEqual([]);
  expect(work.count()).toBe(3);
  third.resolve(undefined);
  await thirdWaiter;
  expect(settled).toEqual(["third"]);
  expect(work.maximumActive()).toBe(1);
});

test("a rejected operation rejects its ticket and still advances pending work", async () => {
  const work = controlledDrain();
  const request = createCoalescedDrain(work.run);
  const firstTicket = request();
  const firstFailure = rejectionOf(firstTicket.completion);
  const first = await work.started(0);
  const secondTicket = request();
  const failure = new DrainFailure({ message: "Synthetic drain failure" });
  first.reject(failure);
  expect(await firstFailure).toBe(failure);
  const second = await work.started(1);
  second.resolve(undefined);
  await secondTicket.completion;
  expect(work.count()).toBe(2);
  expect(work.maximumActive()).toBe(1);
});

test("a completed drain returns to idle and the next request has its own ticket", async () => {
  let runs = 0;
  const request = createCoalescedDrain(async () => {
    runs += 1;
    await Promise.resolve(undefined);
  });
  const first = request();
  await first.completion;
  const second = request();
  expect(second).not.toBe(first);
  await second.completion;
  expect(runs).toBe(2);
});

test("a synchronous work fault rejects its ticket without poisoning future requests", async () => {
  const failure = new DrainFailure({ message: "Synthetic synchronous fault" });
  const request = createCoalescedDrain(() => {
    throw failure;
  });
  const first = request();
  expect(await rejectionOf(first.completion)).toBe(failure);
  const second = request();
  expect(second).not.toBe(first);
  expect(await rejectionOf(second.completion)).toBe(failure);
});

test("a request from the running operation observes the already published slot", async () => {
  let runs = 0;
  let joined: ReturnType<ReturnType<typeof createCoalescedDrain>> | undefined;
  const request = createCoalescedDrain(async () => {
    runs += 1;
    if (runs === 1) {
      joined = request();
    }
    await Promise.resolve(undefined);
  });
  const first = request();
  await first.completion;
  if (joined === undefined) {
    panic("The running operation did not request its follow-up");
  }
  expect(joined).not.toBe(first);
  await joined.completion;
  expect(runs).toBe(2);
});

test("a settlement failure reaches its owner", async () => {
  const failure = new DrainFailure({ message: "Synthetic settlement failure" });
  const originalWithResolvers = Promise.withResolvers.bind(Promise);
  const handled = Promise.withResolvers<unknown>();
  const withResolvers = spyOn(Promise, "withResolvers");
  withResolvers.mockImplementationOnce(() => {
    const resolvers = originalWithResolvers<undefined>();
    return {
      ...resolvers,
      resolve: () => {
        throw failure;
      },
    };
  });
  try {
    const request = createCoalescedDrain(
      async () => await Promise.resolve(undefined),
      {
        onSettlementFailure: (error) => {
          handled.resolve(error);
        },
      },
    );
    request();
  } finally {
    withResolvers.mockRestore();
  }

  expect(await handled.promise).toBe(failure);
});
