import {
  afterEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";
import { DAY_IN_MS, Temporal } from "@stll/time";

import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

import {
  createPublisherGateSlot,
  PUBLISHER_GATES,
  readPublisherCooldown,
  withImmediatePublisherSlot,
} from "./publisher-policy";
import {
  createPublisherRequestSlot,
  publisherGateKeys,
  resetPublisherGateFixtures,
  withPublisherGateFixture,
} from "./publisher-request-gate";
import { fetchPublisher } from "./retry";

// Redis Cluster uses CRC16/XMODEM over the first nonempty hash tag, or the full key.
const redisKeySlot = (key: string) => {
  const opening = key.indexOf("{");
  const closing = opening === -1 ? -1 : key.indexOf("}", opening + 1);
  const hashed = closing > opening + 1 ? key.slice(opening + 1, closing) : key;
  let crc = 0;
  for (const byte of new TextEncoder().encode(hashed)) {
    // oxlint-disable-next-line no-bitwise -- CRC16/XMODEM combines each byte with the high register bits.
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      // oxlint-disable-next-line no-bitwise -- CRC16/XMODEM shifts and reduces its 16-bit polynomial register.
      crc = ((crc << 1) ^ ((crc & 0x80_00) === 0 ? 0 : 0x10_21)) & 0xff_ff;
    }
  }
  return crc % 16_384;
};

const createGateClock = () => {
  let now = 0;
  const values = new Map<string, number>();
  const waiting: { until: number; resolve: () => void }[] = [];
  const sleeps: number[] = [];
  const redis = {
    send: (_command: string, args: string[]) => {
      const keyCount = Number(args.at(1));
      const key = args.at(2);
      if (key === undefined) {
        throw new Error("Gate command has no key");
      }
      // Model Redis replies against a shared clock to exercise scheduling; this fake does not execute Lua.
      if (key.endsWith(":cooldown")) {
        if (args.at(0)?.includes("return untilAt > now")) {
          const deadline = values.get(key) ?? now;
          return deadline > now ? deadline : 0;
        }
        const duration = args.at(3);
        const until = Math.max(
          values.get(key) ?? now,
          duration === undefined ? now : now + Number(duration),
        );
        values.set(key, until);
        return duration === undefined ? Math.max(0, until - now) : until;
      }
      const cooldownKey = keyCount === 2 ? args.at(3) : undefined;
      const slot = Math.max(
        now,
        values.get(key) ?? now,
        cooldownKey === undefined ? now : (values.get(cooldownKey) ?? now),
      );
      if (args.at(0)?.includes("if math.max(reserved, cooldown) > now")) {
        if (slot > now) {
          return 0;
        }
        values.set(key, now + Number(args.at(2 + keyCount)));
        return 1;
      }
      values.set(key, slot + Number(args.at(2 + keyCount)));
      return slot - now;
    },
  };
  const dependencies = {
    redis: () => redis,
    sleep: async (durationMs: number) => {
      sleeps.push(durationMs);
      if (durationMs === 0) {
        return;
      }
      await new Promise<void>((resolve) => {
        waiting.push({ until: now + durationMs, resolve });
      });
    },
  };
  return {
    dependencies,
    sleeps,
    advanceTo: (time: number) => {
      now = time;
      for (const sleeper of waiting.splice(0)) {
        if (sleeper.until <= now) {
          sleeper.resolve();
        } else {
          waiting.push(sleeper);
        }
      }
    },
  };
};

const settleMicrotasks = async () => {
  for (let turn = 0; turn < 40; turn += 1) {
    await Promise.resolve();
  }
};

const CONFIG = {
  intervalMs: 500,
  key: "case-law:publisher-gate:cellar-eu",
  publisher: "EU Cellar",
  cooldown: "shared",
} as const;

describe("default publisher gate fixture isolation", () => {
  afterEach(() => setSystemTime());

  const captured = createPublisherRequestSlot(CONFIG);

  test("a fixture may leave its captured gate paused at a future clock", async () => {
    setSystemTime(Temporal.Now.instant().epochMilliseconds + DAY_IN_MS);
    const deadline = await captured.defer(DAY_IN_MS);
    expect(await captured.readCooldown()).toBe(deadline);
  });

  test("the next fixture starts with the same captured gate unpaused", async () => {
    expect(await captured.readCooldown()).toBeNull();
    expect(await captured.tryReserve()).toBe(true);
  });

  test.each(Object.keys(PUBLISHER_GATES))(
    "%s: captured slots reset across clock changes and repeated scopes",
    async (key) => {
      const slot = createPublisherRequestSlot({
        intervalMs: 500,
        key,
        publisher: key,
      });
      const startedAt = Temporal.Now.instant().epochMilliseconds;
      for (const offset of [0, DAY_IN_MS, -DAY_IN_MS]) {
        setSystemTime(startedAt + offset);
        const deadline = await slot.defer(DAY_IN_MS);
        expect(await slot.readCooldown()).toBe(deadline);
        // Moving the clock backwards cannot itself clear a publisher refusal.
        setSystemTime(startedAt + offset - DAY_IN_MS);
        expect(await slot.readCooldown()).toBe(deadline);
        resetPublisherGateFixtures();
        expect(await slot.readCooldown()).toBeNull();
        expect(await slot.tryReserve()).toBe(true);
        expect(await slot.tryReserve()).toBe(false);
        resetPublisherGateFixtures();
        expect(await slot.tryReserve()).toBe(true);
        resetPublisherGateFixtures();
        expect(await slot.readCooldown()).toBeNull();
      }
    },
  );

  test("resets preserve explicitly injected and scoped publisher state", async () => {
    const clock = createGateClock();
    const injected = createPublisherRequestSlot(CONFIG, clock.dependencies);
    const defaultSlot = createPublisherRequestSlot(CONFIG);
    const deadline = await injected.defer(2000);
    await withPublisherGateFixture(clock.dependencies, async () => {
      expect(await defaultSlot.readCooldown()).toBe(deadline);
      resetPublisherGateFixtures();
      expect(await defaultSlot.readCooldown()).toBe(deadline);
      expect(await injected.readCooldown()).toBe(deadline);
    });
    expect(await defaultSlot.readCooldown()).toBeNull();
    expect(await injected.readCooldown()).toBe(deadline);
  });
});

describe("a publisher cooldown shared across workers", () => {
  test.each(Object.keys(PUBLISHER_GATES))(
    "%s preserves its deployed gate key and colocates its cooldown",
    (publisher) => {
      const { key, cooldownKey } = publisherGateKeys(publisher);
      expect(key).toBe(`case-law:publisher-gate:${publisher}`);
      expect(cooldownKey).toBe(`{${key}}:cooldown`);
      expect(redisKeySlot(cooldownKey)).toBe(redisKeySlot(key));
    },
  );

  test("cluster slot calculation matches known Redis vectors", () => {
    expect(redisKeySlot("123456789")).toBe(12_739);
    expect(redisKeySlot("{user1000}.following")).toBe(3443);
    expect(redisKeySlot("{user1000}.following")).toBe(redisKeySlot("user1000"));
  });

  test("production reservations use the unchanged gate and colocated cooldown", async () => {
    const commands: string[][] = [];
    const gate = createPublisherGateSlot("cellar-eu", {
      redis: () => ({
        send: (_command, args) => {
          commands.push(args);
          return 0;
        },
      }),
      sleep: async () => {},
    });
    await gate();
    expect(commands.at(0)?.slice(2, 4)).toEqual([
      "case-law:publisher-gate:cellar-eu",
      "{case-law:publisher-gate:cellar-eu}:cooldown",
    ]);
  });

  test("cooldown reads expose the shared deadline and become null at expiry", async () => {
    const clock = createGateClock();
    const first = createPublisherRequestSlot(CONFIG, clock.dependencies);
    const second = createPublisherRequestSlot(CONFIG, clock.dependencies);
    expect(await first.readCooldown()).toBeNull();
    expect(await first.defer(2000)).toBe(2000);
    expect(await second.readCooldown()).toBe(2000);
    const shared = createPublisherGateSlot("cellar-eu", clock.dependencies);
    await shared.defer(3000);
    expect(await readPublisherCooldown("cellar-eu", clock.dependencies)).toBe(
      3000,
    );
    clock.advanceTo(3000);
    expect(
      await readPublisherCooldown("cellar-eu", clock.dependencies),
    ).toBeNull();
    expect(await second.readCooldown()).toBeNull();
  });
  test("a second eu-ecj request cannot pass the gate during backoff", async () => {
    const clock = createGateClock();
    const firstWorker = createPublisherRequestSlot(CONFIG, clock.dependencies);
    const secondWorker = createPublisherRequestSlot(CONFIG, clock.dependencies);
    await firstWorker();
    await firstWorker.defer(2000);

    let requested = false;
    const secondRequest = secondWorker().then(async () => {
      requested = true;
      return requested;
    });
    await settleMicrotasks();
    expect(clock.sleeps).toEqual([0, 2000]);
    expect(requested).toBe(false);
    clock.advanceTo(1999);
    await settleMicrotasks();
    expect(requested).toBe(false);
    clock.advanceTo(2000);
    await secondRequest;
    expect(requested).toBe(true);
  });

  test("an already reserved request rechecks a cooldown announced while it sleeps", async () => {
    const clock = createGateClock();
    const firstWorker = createPublisherRequestSlot(CONFIG, clock.dependencies);
    const secondWorker = createPublisherRequestSlot(CONFIG, clock.dependencies);
    await firstWorker();
    let requested = false;
    const queuedRequest = secondWorker().then(async () => {
      requested = true;
      return requested;
    });
    await settleMicrotasks();
    expect(clock.sleeps).toEqual([0, 500]);
    await firstWorker.defer(2000);
    clock.advanceTo(500);
    await settleMicrotasks();
    expect(requested).toBe(false);
    expect(clock.sleeps).toEqual([0, 500, 1500]);
    clock.advanceTo(2000);
    await queuedRequest;
    expect(requested).toBe(true);
  });

  test("a shorter backoff cannot shorten an existing shared cooldown", async () => {
    const clock = createGateClock();
    const firstWorker = createPublisherRequestSlot(CONFIG, clock.dependencies);
    const secondWorker = createPublisherRequestSlot(CONFIG, clock.dependencies);
    await firstWorker.defer(5000);
    await secondWorker.defer(1000);
    let requested = false;
    const pending = secondWorker().then(async () => {
      requested = true;
      return requested;
    });
    await settleMicrotasks();
    expect(clock.sleeps).toEqual([5000]);
    clock.advanceTo(1000);
    await settleMicrotasks();
    expect(requested).toBe(false);
    clock.advanceTo(5000);
    await pending;
    expect(requested).toBe(true);
  });
});

test("immediate reservations share the queued gate and leave a busy slot unchanged", async () => {
  const clock = createGateClock();
  const first = createPublisherRequestSlot(CONFIG, clock.dependencies);
  const second = createPublisherRequestSlot(CONFIG, clock.dependencies);
  expect(await first.tryReserve()).toBe(true);
  expect(await second.tryReserve()).toBe(false);
  expect(clock.sleeps).toEqual([]);
  clock.advanceTo(CONFIG.intervalMs);
  expect(await second.tryReserve()).toBe(true);
});

test("immediate reservations observe active shared cooldown", async () => {
  const clock = createGateClock();
  const first = createPublisherRequestSlot(CONFIG, clock.dependencies);
  const second = createPublisherRequestSlot(CONFIG, clock.dependencies);
  await first.defer(CONFIG.intervalMs * 2);
  expect(await second.tryReserve()).toBe(false);
  clock.advanceTo(CONFIG.intervalMs * 2);
  expect(await second.tryReserve()).toBe(true);
  expect(clock.sleeps).toEqual([]);
});

for (const reply of [-1, 2, "invalid"]) {
  test(`immediate reservations propagate invalid reply ${reply}`, async () => {
    const slot = createPublisherRequestSlot(CONFIG, {
      redis: () => ({ send: () => reply }),
      sleep: async () => {},
    });
    expect(await rejectionOf(slot.tryReserve())).toHaveProperty(
      "message",
      expect.stringContaining("publisher gate returned an invalid wait"),
    );
  });
}

test("read-through requests observe competing requests during preparation", async () => {
  const clock = createGateClock();
  const adapterKey = ADAPTER_KEYS.SK_COURTS;
  const intervalMs = PUBLISHER_GATES["justice-sk"].intervalMs;
  let now = 0;
  const sent: number[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = asFetchMock(
    mock(async () => {
      sent.push(now);
      return new Response("document");
    }),
  );
  const request = async () =>
    await fetchPublisher("https://obcan.justice.sk/document.pdf", {
      adapterKey,
      fetchStage: "document",
      timeoutMs: 1000,
    });
  try {
    const result = await withImmediatePublisherSlot({
      adapterKey,
      dependencies: clock.dependencies,
      operation: async () => {
        // Preparation spans the interval; another worker sends before it finishes.
        now = intervalMs + 100;
        clock.advanceTo(now);
        const competitor = await withImmediatePublisherSlot({
          adapterKey,
          dependencies: clock.dependencies,
          operation: request,
        });
        expect(competitor.status).toBe("completed");
        now += 50;
        clock.advanceTo(now);
        return await request();
      },
    });
    expect(result).toEqual({ status: "pacing-deferred" });
    expect(sent).toEqual([intervalMs + 100]);
    expect(clock.sleeps).toEqual([]);
    now = intervalMs * 2 + 100;
    clock.advanceTo(now);
    expect(
      (
        await withImmediatePublisherSlot({
          adapterKey,
          dependencies: clock.dependencies,
          operation: request,
        })
      ).status,
    ).toBe("completed");
    expect(sent).toEqual([intervalMs + 100, intervalMs * 2 + 100]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preparation without an outbound request leaves the shared gate available", async () => {
  const clock = createGateClock();
  const adapterKey = ADAPTER_KEYS.SK_COURTS;
  expect(
    await withImmediatePublisherSlot({
      adapterKey,
      dependencies: clock.dependencies,
      operation: async () => "claimed",
    }),
  ).toEqual({ status: "completed", value: "claimed" });
  expect(
    await createPublisherGateSlot(
      "justice-sk",
      clock.dependencies,
    ).tryReserve(),
  ).toBe(true);
});

test("non-shared cooldown permits immediate and queued reservations", async () => {
  const clock = createGateClock();
  const { cooldown: _cooldown, ...config } = CONFIG;
  const slot = createPublisherRequestSlot(config, clock.dependencies);
  await slot.defer(CONFIG.intervalMs * 2);
  expect(await slot.readCooldown()).toBe(CONFIG.intervalMs * 2);
  expect(await slot.tryReserve()).toBe(true);
  clock.advanceTo(CONFIG.intervalMs);
  await slot();
  expect(clock.sleeps).toEqual([0]);
});

for (const cooldown of ["shared", "independent"] as const) {
  test(`the local gate honors ${cooldown} cooldown selection`, async () => {
    const { cooldown: _cooldown, ...config } = CONFIG;
    const slot = createPublisherRequestSlot(
      cooldown === "shared" ? CONFIG : config,
    );
    await slot.defer(60_000);
    expect(await slot.readCooldown()).not.toBeNull();
    expect(await slot.tryReserve()).toBe(cooldown === "independent");
  });
}

test("the local queued gate honors independent cooldown selection", async () => {
  const { cooldown: _cooldown, ...config } = CONFIG;
  const slot = createPublisherRequestSlot(config);
  await slot.defer(60_000);
  expect(await slot.readCooldown()).not.toBeNull();
  await slot();
  expect(await slot.tryReserve()).toBe(false);
});
