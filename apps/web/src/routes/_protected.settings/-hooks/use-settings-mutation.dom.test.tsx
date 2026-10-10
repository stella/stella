import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";
import fc from "fast-check";

import { sleep } from "@stll/concurrency/sleep";
import { assertProperty } from "@stll/property-testing";

GlobalRegistrator.register({ url: "http://localhost:3000/settings" });

const ORGANIZATION = "settings-org-a";
const OTHER_ORGANIZATION = "settings-org-b";

// The organization the server resolves for this session when a write is sent.
const server = { activeOrganizationId: ORGANIZATION };

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname.endsWith("/api/auth/get-session")) {
      return Response.json({
        session: {
          userId: "user",
          activeOrganizationId: server.activeOrganizationId,
        },
        user: { id: "user", email: "admin@example.com", name: "Admin" },
      });
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  },
  { preconnect: () => undefined },
);

const query = await import("@tanstack/react-query");
const testing = await import("@testing-library/react");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { SettingsOrganizationChangedError, useSettingsMutation } =
  await import("./use-settings-mutation");

afterEach(() => {
  testing.cleanup();
  server.activeOrganizationId = ORGANIZATION;
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await GlobalRegistrator.unregister();
});

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
    pick: fc.nat(),
    succeeds: fc.boolean(),
  }),
);

// Lets every queued mutation that is allowed to start reach the transport:
// TanStack continues the next scoped mutation from a settled promise chain.
const drain = async () => await testing.act(async () => await sleep(0));

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
  // Errors the hook reported through `onError`, in order.
  const errors: unknown[] = [];
  const wrapper = ({ children }: { children: ReactNode }) => (
    <query.QueryClientProvider client={client}>
      <AuthenticatedUserProvider
        user={{
          activeOrganizationId: ORGANIZATION,
          email: "admin@example.com",
          id: "user",
          image: null,
          name: "Admin",
          preferredName: null,
          timezoneId: "UTC",
          wordEditShortcut: null,
        }}
      >
        {children}
      </AuthenticatedUserProvider>
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
        onError: (error) => {
          errors.push(error);
        },
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
    errors,
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
    "settings writes to one resource reach the server in submission order",
    fc.asyncProperty(
      fc
        .array(step)
        .chain((steps) =>
          fc.tuple(
            fc.constant(steps),
            fc.array(fc.boolean(), { maxLength: steps.length }),
          ),
        ),
      async ([steps, tailOutcomes]) => {
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
          await runSettle(tail, tailOutcomes[tail] ?? true);
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

test("a queued write is not sent once the active organization has changed", async () => {
  const harness = mountSettingsMutation();
  await harness.submit(0);
  await harness.submit(1);
  expect(harness.sent).toEqual([0]);
  // The member switches organization while write 0 is in flight.
  server.activeOrganizationId = OTHER_ORGANIZATION;
  await harness.settle(0, true);
  // Write 0 was already sent for the submitting organization; write 1 is not.
  expect(harness.sent).toEqual([0]);
  expect(harness.applied).toEqual([0]);
  expect(harness.inFlight).toEqual([]);
  expect(harness.errors).toHaveLength(1);
  expect(SettingsOrganizationChangedError.is(harness.errors[0])).toBe(true);
  expect(harness.client.isMutating()).toBe(0);
  harness.unmount();
  harness.client.clear();
});

test("a write is not sent when the active organization changed before submission", async () => {
  const harness = mountSettingsMutation();
  server.activeOrganizationId = OTHER_ORGANIZATION;
  await harness.submit(0);
  expect(harness.sent).toEqual([]);
  expect(harness.errors).toHaveLength(1);
  expect(SettingsOrganizationChangedError.is(harness.errors[0])).toBe(true);
  harness.unmount();
  harness.client.clear();
});
