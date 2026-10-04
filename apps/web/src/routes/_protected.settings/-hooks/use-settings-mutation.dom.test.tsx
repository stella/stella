import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

GlobalRegistrator.register({ url: "http://localhost:3000/settings" });

const query = await import("@tanstack/react-query");
const testing = await import("@testing-library/react");
const { useSettingsMutation } = await import("./use-settings-mutation");

afterEach(() => testing.cleanup());
afterAll(async () => GlobalRegistrator.unregister());

const SETTINGS_KEY = ["settings-mutation-order-test"] as const;

type InFlight = {
  value: number;
  settle: ReturnType<typeof Promise.withResolvers<number>>;
};

type Step =
  | { kind: "submit" }
  | { kind: "settle"; pick: number; succeeds: boolean };

const step: fc.Arbitrary<Step> = fc.oneof(
  fc.constant({ kind: "submit" as const }),
  fc.record({
    kind: fc.constant("settle" as const),
    pick: fc.nat({ max: 7 }),
    succeeds: fc.boolean(),
  }),
);

// Lets every queued mutation that is allowed to start reach the transport:
// TanStack continues the next scoped mutation from a settled promise chain.
const drain = async () =>
  await testing.act(
    async () =>
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
  );

const mountSettingsMutation = () => {
  const client = new query.QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const inFlight: InFlight[] = [];
  // Values the fake server has committed, in commit order.
  const applied: number[] = [];
  // Values in the order the transport sent them.
  const sent: number[] = [];
  let maxConcurrent = 0;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <query.QueryClientProvider client={client}>
      {children}
    </query.QueryClientProvider>
  );
  const { result, unmount } = testing.renderHook(
    () =>
      useSettingsMutation({
        mutationFn: async (value: number) => {
          const settle = Promise.withResolvers<number>();
          sent.push(value);
          inFlight.push({ value, settle });
          maxConcurrent = Math.max(maxConcurrent, inFlight.length);
          return await settle.promise;
        },
        invalidate: SETTINGS_KEY,
      }),
    { wrapper },
  );
  const settle = async (pick: number, succeeds: boolean) => {
    const index = pick % inFlight.length;
    const [call] = inFlight.splice(index, 1);
    if (!call) {
      throw new Error("Expected an in-flight settings write");
    }
    await testing.act(async () => {
      if (succeeds) {
        applied.push(call.value);
        call.settle.resolve(call.value);
      } else {
        call.settle.reject(new Error(`write ${call.value} failed`));
      }
    });
    await drain();
  };
  return {
    client,
    inFlight,
    applied,
    sent,
    maxConcurrent: () => maxConcurrent,
    submit: async (value: number) => {
      testing.act(() => {
        // swallow-ok: each write's outcome is asserted via the fake server log
        result.current.mutateAsync(value).catch(() => undefined);
      });
      await drain();
    },
    settle,
    unmount,
  };
};

test("settings writes to one resource reach the server in submission order", async () => {
  await assertProperty(
    "settings-mutation-submission-order",
    fc.asyncProperty(
      fc.array(step, { minLength: 1, maxLength: 16 }),
      fc.array(fc.boolean(), { maxLength: 8 }),
      async (steps, tailOutcomes) => {
        const harness = mountSettingsMutation();
        const submitted: number[] = [];
        const succeeded = new Set<number>();
        const runSettle = async (pick: number, succeeds: boolean) => {
          const index = pick % harness.inFlight.length;
          const value = harness.inFlight[index]?.value;
          if (value !== undefined && succeeds) {
            succeeded.add(value);
          }
          await harness.settle(pick, succeeds);
        };
        for (const next of steps) {
          if (next.kind === "submit") {
            const value = submitted.length;
            submitted.push(value);
            await harness.submit(value);
          } else if (harness.inFlight.length > 0) {
            await runSettle(next.pick, next.succeeds);
          }
        }
        let tail = 0;
        while (harness.inFlight.length > 0) {
          await runSettle(tail, tailOutcomes[tail % 8] ?? true);
          tail += 1;
        }

        // Every submitted write was sent exactly once, in submission order.
        expect(harness.sent).toEqual(submitted);
        expect(harness.client.isMutating()).toBe(0);
        // Never more than one write to the resource on the wire at a time.
        expect(harness.maxConcurrent()).toBeLessThanOrEqual(1);
        // The server committed the successful writes in submission order.
        expect(harness.applied).toEqual(
          submitted.filter((value) => succeeded.has(value)),
        );
        // When the last submitted write succeeds, it is the persisted value.
        const last = submitted.at(-1);
        if (last !== undefined && succeeded.has(last)) {
          expect(harness.applied.at(-1)).toBe(last);
        }
        harness.unmount();
        harness.client.clear();
      },
    ),
  );
});

test("a write submitted while another is in flight waits until it settles", async () => {
  const harness = mountSettingsMutation();
  await harness.submit(0);
  await harness.submit(1);
  expect(harness.inFlight.map((call) => call.value)).toEqual([0]);
  await harness.settle(0, false);
  expect(harness.inFlight.map((call) => call.value)).toEqual([1]);
  await harness.settle(0, true);
  expect(harness.applied).toEqual([1]);
  expect(harness.client.isMutating()).toBe(0);
  harness.unmount();
  harness.client.clear();
});
