import { expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import { createLinkIconCache } from "./cache";

const subject = {
  hostname: "example.com",
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
        send: () => Promise.reject(new Error("offline")),
        close: () => undefined,
      };
    },
    onRedisError: () => {
      failures++;
    },
  });
  expect(connections).toBe(0);
  expect(await cache.readOrLease(subject)).toEqual({ type: "no-icon" });
  expect(await cache.readOrLease(subject)).toEqual({ type: "no-icon" });
  expect(connections).toBe(2);
  expect(failures).toBe(2);
});

test("positive cache envelopes round trip bytes and oversized fills are rejected", async () => {
  let payload: string | undefined;
  let sends = 0;
  const cache = createLinkIconCache({
    createRedis: () => ({
      send: (_command, args) => {
        sends++;
        if (args.at(0)?.includes("local cost")) {
          payload = args.at(6);
          return Promise.resolve("S");
        }
        return Promise.resolve(payload);
      },
      close: () => undefined,
    }),
  });
  const bytes = new Uint8Array([0, 127, 128, 255]);
  await cache.store({
    hostname: subject.hostname,
    token: "lease",
    icon: { bytes, mime: "image/png" },
  });
  expect(await cache.readOrLease(subject)).toEqual({
    type: "hit",
    icon: { bytes, mime: "image/png" },
  });
  const before = sends;
  await cache.store({
    hostname: subject.hostname,
    token: "lease",
    icon: { bytes: new Uint8Array(65_537), mime: "image/png" },
  });
  expect(sends).toBe(before);
  cache.close();
});
