import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";

import { Temporal } from "@stll/time";

import { unregisterDomEnvironment } from "@/test-dom-environment";

// A DOM for this file only: the hook's contract is about what a committed
// render reads before and after its timer fires.
GlobalRegistrator.register({ url: "http://localhost:3000/law" });

const { renderHook, waitFor } = await import("@testing-library/react");
const { useTimePassed } = await import("@/hooks/use-time-passed");

afterAll(async () => {
  await unregisterDomEnvironment();
});

const fromNow = (ms: number) =>
  new Date(Temporal.Now.instant().epochMilliseconds + ms);

describe("useTimePassed", () => {
  test("an absent time has passed from the first render", () => {
    const { result } = renderHook(() => useTimePassed(undefined));
    expect(result.current).toBe(true);
  });

  test("a time ahead holds until the clock passes it, then turns without a reload", async () => {
    const at = fromNow(80);
    const renders: boolean[] = [];
    const { result } = renderHook(() => {
      const passed = useTimePassed(at);
      renders.push(passed);
      return passed;
    });
    expect(renders.at(0)).toBe(false);
    await waitFor(() => {
      expect(result.current).toBe(true);
    });
    expect(Temporal.Now.instant().epochMilliseconds).toBeGreaterThanOrEqual(
      at.getTime(),
    );
  });

  test("a time already behind renders unpassed first, as the server does, then passed", async () => {
    const renders: boolean[] = [];
    const at = fromNow(-1000);
    const { result } = renderHook(() => {
      const passed = useTimePassed(at);
      renders.push(passed);
      return passed;
    });
    expect(renders.at(0)).toBe(false);
    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });

  test("a new time ahead starts unpassed again", async () => {
    const { result, rerender } = renderHook(
      ({ at }: { at: Date }) => useTimePassed(at),
      { initialProps: { at: fromNow(-1000) } },
    );
    await waitFor(() => {
      expect(result.current).toBe(true);
    });
    rerender({ at: fromNow(60_000) });
    expect(result.current).toBe(false);
  });
});
