import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";
import { Temporal } from "@stll/time";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { PUBLISHER_GATES } from "@/api/lib/legal-search/publisher-gates";
import type { PublisherGateAccess } from "@/api/lib/legal-search/publisher-gates";

import { runPublisherConnectionRequest } from "./publisher-connection";
import { createPublisherRequestSlot } from "./publisher-request-gate";

const at = (local: string) =>
  Temporal.ZonedDateTime.from(`${local}[Europe/Vienna]`).epochMilliseconds;
const ACCESS = PUBLISHER_GATES["ris-bka"].access;
const INTERVAL_MS = PUBLISHER_GATES["ris-bka"].intervalMs;

// This fake exercises the command boundary; Lua atomicity and server expiry
// additionally require the service-backed Valkey suite.
const coordinator = (initialTime = at("2026-10-20T22:00")) => {
  let now = initialTime;
  let owner: { token: string; expiresAt: number } | undefined;
  let nextStart = 0;
  const events: string[] = [];
  const sleeping = Promise.withResolvers<undefined>();
  const wake = Promise.withResolvers<undefined>();
  const redis = {
    send: (command: string, args: string[]) => {
      expect(command).toBe("EVAL");
      expect(args.at(1)).toBe("2");
      const script = args.at(0) ?? "";
      const token = args.at(4) ?? "";
      if (owner !== undefined && owner.expiresAt <= now) {
        owner = undefined;
      }
      if (script.includes('redis.call("EXISTS"')) {
        if (owner !== undefined || nextStart > now) {
          return 0;
        }
        owner = { token, expiresAt: now + Number(args.at(5)) };
        nextStart = now + Number(args.at(6));
        events.push("acquired");
        return 1;
      }
      expect(script).toContain('redis.call("DEL"');
      if (owner?.token !== token) {
        return 0;
      }
      owner = undefined;
      nextStart = now + Number(args.at(5));
      events.push("released");
      return 1;
    },
  };
  const slot = () =>
    createPublisherRequestSlot(
      { intervalMs: INTERVAL_MS, key: "ris-bka", publisher: "RIS" },
      {
        redis: () => redis,
        now: () => now,
        sleep: async (_duration, signal) => {
          signal?.throwIfAborted();
          sleeping.resolve(undefined);
          await wake.promise;
          now += INTERVAL_MS;
          signal?.throwIfAborted();
        },
      },
    );
  return {
    slot,
    events,
    sleeping,
    wake,
    owner: () => owner,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

type RunOptions = {
  slot: ReturnType<typeof createPublisherRequestSlot>;
  request: (signal: AbortSignal) => Promise<Response>;
  signal?: AbortSignal;
  access?: PublisherGateAccess;
  mode?: "immediate";
};
const run = ({ slot, request, signal, access = ACCESS, mode }: RunOptions) =>
  runPublisherConnectionRequest({
    adapterKey: ADAPTER_KEYS.AT_COURTS,
    access,
    slot,
    request,
    signal,
    mode,
  });

const delayedBody = () => {
  const started = Promise.withResolvers<undefined>();
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  return {
    started,
    request: async (_signal: AbortSignal) => {
      started.resolve(undefined);
      return response;
    },
    finish: () => {
      streamController?.enqueue(new TextEncoder().encode("decision"));
      streamController?.close();
    },
    cancelled: () => cancelled,
  };
};

describe("publisher connections retain shared ownership through the response body", () => {
  test("immediate mode defers a closed window without sending", async () => {
    const state = coordinator(at("2026-10-20T12:00"));
    let sent = 0;
    expect(
      await rejectionOf(
        run({
          slot: state.slot(),
          mode: "immediate",
          request: async () => {
            sent++;
            return new Response();
          },
        }),
      ),
    ).toMatchObject({ status: "pacing-deferred" });
    expect(sent).toBe(0);
    expect(state.events).toEqual([]);
  });

  test("immediate mode never queues behind an active connection", async () => {
    const state = coordinator();
    const owner = state.slot();
    expect(
      await owner.tryAcquireConnection({ token: "owner", holdMs: 30_000 }),
    ).toBe(true);
    let sent = 0;
    expect(
      await rejectionOf(
        run({
          slot: state.slot(),
          mode: "immediate",
          request: async () => {
            sent++;
            return new Response();
          },
        }),
      ),
    ).toMatchObject({ status: "pacing-deferred" });
    expect(sent).toBe(0);
    expect(state.owner()?.token).toBe("owner");
    await owner.releaseConnection("owner");
  });

  test("a closed schedule and an unsupported year send no request or coordination command", async () => {
    for (const time of ["2026-10-20T12:00", "2032-01-01T22:00"]) {
      const state = coordinator(at(time));
      let sent = 0;
      expect(
        await rejectionOf(
          run({
            slot: state.slot(),
            request: async () => {
              sent++;
              return new Response();
            },
          }),
        ),
      ).toMatchObject({
        message: expect.stringMatching(
          /Publisher access (window is closed|calendar is unavailable)/u,
        ),
      });
      expect(sent).toBe(0);
      expect(state.events).toEqual([]);
    }
  });

  test("two worker slots wait for delayed body completion and the release interval", async () => {
    const state = coordinator();
    const body = delayedBody();
    const first = run({ slot: state.slot(), request: body.request });
    await body.started.promise;
    const starts: number[] = [];
    const secondSlot = state.slot();
    const second = run({
      slot: secondSlot,
      request: async () => {
        starts.push(secondSlot.now());
        return new Response("second");
      },
    });
    await state.sleeping.promise;
    expect(state.events).toEqual(["acquired"]);
    expect(starts).toEqual([]);
    body.finish();
    expect(await (await first).text()).toBe("decision");
    expect(state.events).toEqual(["acquired", "released"]);
    const releasedAt = secondSlot.now();
    state.wake.resolve(undefined);
    expect(await (await second).text()).toBe("second");
    expect(starts).toEqual([releasedAt + INTERVAL_MS]);
    expect(state.events).toEqual([
      "acquired",
      "released",
      "acquired",
      "released",
    ]);
    expect(state.owner()).toBeUndefined();
  });

  test("caller abort cancels a stalled body before releasing ownership", async () => {
    const state = coordinator();
    const body = delayedBody();
    const controller = new AbortController();
    const pending = run({
      slot: state.slot(),
      request: body.request,
      signal: controller.signal,
    });
    await body.started.promise;
    controller.abort(new DOMException("caller stopped", "AbortError"));
    expect(await rejectionOf(pending)).toMatchObject({
      message: expect.stringMatching("caller stopped"),
    });
    expect(body.cancelled()).toBe(true);
    expect(state.events).toEqual(["acquired", "released"]);
  });

  test("the closing deadline cancels a stalled body and releases ownership", async () => {
    const state = coordinator(at("2026-10-21T04:59:59.980"));
    const body = delayedBody();
    expect(
      await rejectionOf(run({ slot: state.slot(), request: body.request })),
    ).toMatchObject({ message: expect.stringMatching(/timed out|timeout/iu) });
    expect(body.cancelled()).toBe(true);
    expect(state.events).toEqual(["acquired", "released"]);
  });

  test("an unavailable coordinator fails closed before opening a connection", async () => {
    const slot = createPublisherRequestSlot(
      { intervalMs: INTERVAL_MS, key: "ris-bka", publisher: "RIS" },
      {
        now: () => at("2026-10-20T22:00"),
        redis: () => {
          throw new DOMException("coordinator unavailable", "NetworkError");
        },
        sleep: async () => {},
      },
    );
    let sent = 0;
    expect(
      await rejectionOf(
        run({
          slot,
          request: async () => {
            sent++;
            return new Response();
          },
        }),
      ),
    ).toMatchObject({
      message: expect.stringMatching("coordinator unavailable"),
    });
    expect(sent).toBe(0);
  });

  test("excess response bytes cancel the upstream body and release ownership", async () => {
    const state = coordinator();
    let cancelled = false;
    expect(
      await rejectionOf(
        run({
          slot: state.slot(),
          access: { ...ACCESS, maxResponseBytes: 2 },
          request: async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new Uint8Array(3));
                },
                cancel() {
                  cancelled = true;
                },
              }),
            ),
        }),
      ),
    ).toMatchObject({
      message: expect.stringMatching(
        "Publisher response exceeds the connection byte limit",
      ),
    });
    expect(cancelled).toBe(true);
    expect(state.events).toEqual(["acquired", "released"]);
  });

  test("crashed ownership expires and its stale release cannot delete the next owner", async () => {
    const state = coordinator();
    const crashed = state.slot();
    const winner = state.slot();
    expect(
      await crashed.tryAcquireConnection({ token: "crashed", holdMs: 100 }),
    ).toBe(true);
    expect(
      await winner.tryAcquireConnection({ token: "winner", holdMs: 20_000 }),
    ).toBe(false);
    state.advance(INTERVAL_MS);
    expect(
      await winner.tryAcquireConnection({ token: "winner", holdMs: 20_000 }),
    ).toBe(true);
    expect(
      await rejectionOf(crashed.releaseConnection("crashed")),
    ).toMatchObject({
      message: expect.stringMatching("Publisher connection ownership lost"),
    });
    expect(state.owner()?.token).toBe("winner");
    await winner.releaseConnection("winner");
    expect(state.owner()).toBeUndefined();
  });
});
