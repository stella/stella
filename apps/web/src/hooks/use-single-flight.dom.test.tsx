import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const { act, renderHook } = await import("@testing-library/react");
const { useSingleFlight } = await import("@/hooks/use-single-flight");

afterAll(async () => {
  await unregisterDomEnvironment();
});

test("a second submit in the same frame is ignored until the first settles", async () => {
  const { result } = renderHook(() => useSingleFlight());
  const first = Promise.withResolvers<undefined>();
  let calls = 0;
  const submit = async () => {
    calls += 1;
    await first.promise;
  };

  let firstRun: Promise<void> = Promise.resolve();
  let secondRun: Promise<void> = Promise.resolve();
  act(() => {
    firstRun = result.current.run(submit);
    secondRun = result.current.run(submit);
  });
  expect(calls).toBe(1);
  expect(result.current.pending).toBe(true);

  await act(async () => {
    first.resolve(undefined);
    await Promise.all([firstRun, secondRun]);
  });
  expect(result.current.pending).toBe(false);

  await act(async () => {
    await result.current.run(async () => {
      calls += 1;
    });
  });
  expect(calls).toBe(2);
});

test("a failed submit frees the form for the next attempt", async () => {
  const { result } = renderHook(() => useSingleFlight());

  let failed: Promise<void> = Promise.resolve();
  await act(async () => {
    failed = result.current.run(async () => {
      throw new Error("network");
    });
    expect(await rejectionOf(failed)).toBeInstanceOf(Error);
  });
  expect(result.current.pending).toBe(false);

  let retried = false;
  await act(async () => {
    await result.current.run(async () => {
      retried = true;
    });
  });
  expect(retried).toBe(true);
});

test("a callback-style mutation settles through runSettled once", async () => {
  const { result } = renderHook(() => useSingleFlight());
  let settle: () => void = () => undefined;
  let starts = 0;
  const start = (settled: () => void) => {
    starts += 1;
    settle = settled;
  };

  let firstRun: Promise<void> = Promise.resolve();
  let secondRun: Promise<void> = Promise.resolve();
  act(() => {
    firstRun = result.current.runSettled(start);
    secondRun = result.current.runSettled(start);
  });
  expect(starts).toBe(1);
  expect(result.current.pending).toBe(true);

  await act(async () => {
    settle();
    await Promise.all([firstRun, secondRun]);
  });
  expect(result.current.pending).toBe(false);
});
