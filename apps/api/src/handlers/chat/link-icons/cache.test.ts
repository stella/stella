import { expect, test } from "bun:test";

import { toRegistrableIconSite } from "@/api/handlers/chat/link-icons/origin";
import { toSafeId } from "@/api/lib/branded-types";

import { createLinkIconCache } from "./cache";

const subject = {
  hostname: toRegistrableIconSite("example.com").unwrap(),
  userId: toSafeId<"user">("user"),
  ip: "192.0.2.1",
};

test("cache failures never authorize outbound work and a later request reconnects", async () => {
  let connections = 0;
  let failures = 0;
  const cache = createLinkIconCache({
    createRedis: () => {
      connections++;
      return {
        connect: async () => undefined,
        send: async () => {
          throw new Error("offline");
        },
        close: () => undefined,
      };
    },
    onRedisError: () => {
      failures++;
    },
  });
  expect(connections).toBe(0);
  expect(await cache.readOrLease(subject)).toEqual({ type: "temporary" });
  expect(await cache.readOrLease(subject)).toEqual({ type: "temporary" });
  expect(connections).toBe(2);
  expect(failures).toBe(2);
});

test("positive cache envelopes round trip bytes and oversized fills are rejected", async () => {
  let payload: string | undefined;
  let sends = 0;
  const cache = createLinkIconCache({
    createRedis: () => ({
      connect: async () => undefined,
      send: async (_command, args) => {
        sends++;
        if (args.at(0)?.includes("local cost")) {
          payload = args.at(6);
          return "S";
        }
        return payload;
      },
      close: () => undefined,
    }),
  });
  const bytes = new Uint8Array([0, 127, 128, 255]);
  await cache.store({
    hostname: subject.hostname,
    token: "lease",
    outcome: { type: "icon", icon: { bytes, mime: "image/png" } },
  });
  expect(await cache.readOrLease(subject)).toEqual({
    type: "icon",
    icon: { bytes, mime: "image/png" },
  });
  const before = sends;
  await cache.store({
    hostname: subject.hostname,
    token: "lease",
    outcome: {
      type: "icon",
      icon: { bytes: new Uint8Array(65_537), mime: "image/png" },
    },
  });
  expect(sends).toBe(before);
  cache.close();
});

test("cold requests share their connection and send only after it is ready", async () => {
  const connected = Promise.withResolvers();
  let connects = 0;
  let sends = 0;
  const cache = createLinkIconCache({
    createRedis: () => ({
      connect: async () => {
        connects++;
        return connected.promise;
      },
      send: async (_command, args) => {
        sends++;
        const token = args.at(7);
        expect(typeof token).toBe("string");
        return `A${String(token)}`;
      },
      close: () => undefined,
    }),
  });
  const first = cache.readOrLease(subject);
  const second = cache.readOrLease(subject);
  await Promise.resolve();
  expect(connects).toBe(1);
  expect(sends).toBe(0);
  connected.resolve(undefined);
  const results = await Promise.all([first, second]);
  expect(results.every((result) => result.type === "lease")).toBe(true);
  expect(sends).toBe(2);
  cache.close();
});

test("only stored negative entries establish a missing icon", async () => {
  for (const envelope of ["N", "T", "Lsomeone-else", null]) {
    const cache = createLinkIconCache({
      createRedis: () => ({
        connect: async () => undefined,
        send: async () => envelope,
        close: () => undefined,
      }),
    });
    expect(await cache.readOrLease(subject)).toEqual({
      type: envelope === "N" ? "no-icon" : "temporary",
    });
    cache.close();
  }
});
