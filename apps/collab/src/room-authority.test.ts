import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import * as Y from "yjs";

import { CANONICAL_YJS_AUTHORITY } from "@stll/folio-core/controller/canonicalYjsRoom";
import { createDocx, createEmptyDocument } from "@stll/folio-core/server";
import { createTestClock, deferred, waitFor } from "@stll/test-kit";

import { createRoomAuthorities } from "./room-authority";

const SEED_DOCX = new Uint8Array(
  await createDocx(createEmptyDocument({ initialText: "Seed." })),
);
const ROOM = { roomId: "room-1", roomName: "folio:room-1" };
const LEASE_KEY = `collab:authority:${ROOM.roomName}`;

/** A Redis that keeps leases as the lease scripts do; `hold` delays its replies. */
const createLeaseRedis = () => {
  const leases = new Map<string, string>();
  const calls: ("acquire" | "release")[] = [];
  const redis = {
    calls,
    hold: undefined as Deferred | undefined,
    leases,
    eval: async (
      script: string,
      _numKeys: number,
      ...args: (number | string)[]
    ) => {
      const [key, holder] = args.map(String);
      if (key === undefined || holder === undefined) {
        throw new Error("A lease script names its key and holder.");
      }
      const acquire = script.includes("PEXPIRE");
      calls.push(acquire ? "acquire" : "release");
      await redis.hold?.promise;
      const current = leases.get(key);
      if (acquire) {
        if (current !== undefined && current !== holder) {
          return 0;
        }
        leases.set(key, holder);
        return 1;
      }
      if (current !== holder) {
        return 0;
      }
      leases.delete(key);
      return 1;
    },
  };
  return redis;
};

type Deferred = ReturnType<typeof deferred<undefined>>;

const redisCoordination = (redis: ReturnType<typeof createLeaseRedis>) => ({
  type: "redis" as const,
  redis,
  keyPrefix: "collab",
  holder: "instance-a",
});

const authorityWrote = (doc: Y.Doc) =>
  doc.store.clients.has(CANONICAL_YJS_AUTHORITY);

const running: ReturnType<typeof createRoomAuthorities>[] = [];
const track = (authorities: ReturnType<typeof createRoomAuthorities>) => {
  running.push(authorities);
  return authorities;
};

afterEach(async () => {
  await Promise.all(running.splice(0).map(async (a) => await a.stopAll()));
});

describe("room authority", () => {
  test("a single process serves the room it loads", async () => {
    const authorities = track(
      createRoomAuthorities({ coordination: { type: "single-process" } }),
    );
    const doc = new Y.Doc();

    const started = await authorities.start({
      ...ROOM,
      doc,
      seedDocx: SEED_DOCX,
    });

    expect(started.unwrap()).toBe("serving");
    expect(authorityWrote(doc)).toBe(true);
  });

  test("an unreadable seed fails the start", async () => {
    const authorities = track(
      createRoomAuthorities({ coordination: { type: "single-process" } }),
    );

    const started = await authorities.start({
      ...ROOM,
      doc: new Y.Doc(),
      seedDocx: new Uint8Array([1, 2, 3]),
    });

    expect(Result.isError(started)).toBe(true);
    if (Result.isError(started)) {
      expect(started.error.reason).toBe("seedUnreadable");
    }
    expect(authorities.roleOf(ROOM.roomName)).toBeUndefined();
  });

  test("an authority that cannot serve fails the start and gives its lease back", async () => {
    const clock = createTestClock();
    const redis = createLeaseRedis();
    const authorities = track(
      createRoomAuthorities({
        clock,
        coordination: redisCoordination(redis),
        leaseRenewMs: 20,
      }),
    );
    const doc = new Y.Doc();
    doc.getMap("folio.canonical.room").set("snapshot", "another-document");

    const started = await authorities.start({
      ...ROOM,
      doc,
      seedDocx: SEED_DOCX,
    });

    expect(Result.isError(started)).toBe(true);
    if (Result.isError(started)) {
      expect(started.error.reason).toBe("snapshotMismatch");
    }
    expect(redis.leases.has(LEASE_KEY)).toBe(false);
    expect(redis.calls).toEqual(["acquire", "release"]);
    // No renewal keeps a lease for an authority that does not run.
    await clock.advance(100);
    expect(redis.calls).toEqual(["acquire", "release"]);
    expect(clock.pendingSleepers()).toBe(0);
  });

  test("a lease granted after it could have expired never starts serving", async () => {
    const clock = createTestClock();
    const redis = createLeaseRedis();
    redis.hold = deferred<undefined>();
    const authorities = track(
      createRoomAuthorities({
        clock,
        coordination: redisCoordination(redis),
        leaseDriftMs: 50,
        leaseRenewMs: 10_000,
        leaseTtlMs: 150,
      }),
    );
    const doc = new Y.Doc();

    const starting = authorities.start({ ...ROOM, doc, seedDocx: SEED_DOCX });
    await waitFor(() => (redis.calls.length > 0 ? true : undefined), {
      description: "the lease request",
    });
    await clock.advance(150);
    redis.hold.resolve(undefined);

    expect((await starting).unwrap()).toBe("relaying");
    expect(authorityWrote(doc)).toBe(false);
  });

  test("a serving authority whose lease is not renewed in time stops before it expires", async () => {
    const clock = createTestClock();
    const authorities = track(
      createRoomAuthorities({
        clock,
        coordination: redisCoordination(createLeaseRedis()),
        leaseDriftMs: 50,
        leaseRenewMs: 10_000,
        leaseTtlMs: 150,
      }),
    );

    const started = await authorities.start({
      ...ROOM,
      doc: new Y.Doc(),
      seedDocx: SEED_DOCX,
    });

    expect(started.unwrap()).toBe("serving");
    await clock.advance(99);
    expect(authorities.roleOf(ROOM.roomName)).toBe("serving");
    await clock.advance(1);
    expect(authorities.roleOf(ROOM.roomName)).toBe("relaying");
  });

  test("a renewed lease keeps its authority serving", async () => {
    const clock = createTestClock();
    const redis = createLeaseRedis();
    const authorities = track(
      createRoomAuthorities({
        clock,
        coordination: redisCoordination(redis),
        leaseDriftMs: 50,
        leaseRenewMs: 30,
        leaseTtlMs: 150,
      }),
    );

    const started = await authorities.start({
      ...ROOM,
      doc: new Y.Doc(),
      seedDocx: SEED_DOCX,
    });

    expect(started.unwrap()).toBe("serving");
    await clock.advance(250);
    expect(authorities.roleOf(ROOM.roomName)).toBe("serving");
    expect(redis.calls.filter((call) => call === "acquire")).toHaveLength(9);
    await authorities.stop(ROOM.roomName);
    expect(redis.leases.has(LEASE_KEY)).toBe(false);
  });
});
