import { describe, expect, test } from "bun:test";

import {
  createPublisherGateSlot,
  PUBLISHER_GATES,
  readPublisherCooldown,
} from "./publisher-policy";
import {
  createPublisherRequestSlot,
  publisherGateKeys,
} from "./publisher-request-gate";

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
