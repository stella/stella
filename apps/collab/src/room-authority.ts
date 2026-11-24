import { panic, Result, TaggedError } from "better-result";
import { setTimeout as sleepFor } from "node:timers/promises";
import type * as Y from "yjs";

import {
  type CanonicalYjsAuthority,
  serveCanonicalYjsRoom,
} from "@stll/folio-core/controller/canonicalYjsRoom";
import { FolioDocxReviewer } from "@stll/folio-core/server";

import { logCollabEvent } from "./log";

/*
 * Every edit to a room goes through one authority: it sequences the batches
 * peers append to the room's inbox and writes the journal every peer
 * follows. It runs on the server's copy of the room's Yjs document. With
 * Redis, every instance a room's peers reach loads that document, and only
 * the instance holding the room's authority lease runs the authority; the
 * others relay. An instance serves only while its lease is valid: from the
 * moment it asked Redis for the lease, for the lease's TTL less a margin for
 * clock drift. A grant that arrives after that never starts serving, and an
 * authority whose renewal has not landed by then stops, before Redis can hand
 * the lease to another instance, so two authorities never write one journal.
 */

const LEASE_TTL_MS = 15_000;
const LEASE_RENEW_MS = 5000;
/** How long before the lease can expire in Redis its holder stops serving. */
const LEASE_DRIFT_MS = 1000;

/** Take the lease, or renew it when this holder already has it. */
const ACQUIRE_LEASE = `
local current = redis.call("GET", KEYS[1])
if current == ARGV[1] then
  redis.call("PEXPIRE", KEYS[1], ARGV[2])
  return 1
end
if not current then
  redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2])
  return 1
end
return 0
`;

/** Give the lease back, only when this holder has it. */
const RELEASE_LEASE = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

/** The time a lease is measured on: monotonic, and sleeps a renewal waits. */
type LeaseClock = {
  monotonic: () => number;
  sleep: (
    milliseconds: number,
    options?: { signal?: AbortSignal },
  ) => Promise<void>;
};

const systemLeaseClock: LeaseClock = {
  monotonic: () => performance.now(),
  sleep: async (milliseconds, options) => {
    await sleepFor(milliseconds, undefined, options);
  },
};

/** The one Redis command a lease takes: running a script on its key. */
type LeaseRedis = {
  eval: (
    script: string,
    numKeys: number,
    ...args: (number | string)[]
  ) => Promise<unknown>;
};

/** Who runs a room's authority: this process alone, or a Redis lease's holder. */
type RoomAuthorityCoordination =
  | { type: "single-process" }
  | {
      type: "redis";
      redis: LeaseRedis;
      /** Prefix of the lease keys; the room name keeps them in its slot. */
      keyPrefix: string;
      /** This instance's identity as a lease holder. */
      holder: string;
    };
type RedisCoordination = Extract<RoomAuthorityCoordination, { type: "redis" }>;

/** The room's authority cannot run: its peers' edits would never land. */
class RoomAuthorityStartError extends TaggedError("RoomAuthorityStartError")<{
  message: string;
  reason: string;
}> {}

type RoomAuthorityState =
  | { type: "opening" }
  | { type: "relaying" }
  | { type: "serving"; authority: CanonicalYjsAuthority }
  | { type: "failed"; error: RoomAuthorityStartError }
  | { type: "stopped" };

/** What this instance does for a room once its authority started. */
type RoomAuthorityRole = "relaying" | "serving" | "stopped";

type RunningRoom = {
  roomId: string;
  state: RoomAuthorityState;
  /** Aborted when the room retires: ends its lease renewals. */
  retired: AbortController;
  /** Aborted when a later grant or a stop supersedes the lease's deadline. */
  deadline: AbortController | undefined;
};

type StartRoomAuthorityOptions = {
  /** The server's copy of the room's Yjs document, its stored state loaded. */
  doc: Y.Doc;
  roomId: string;
  roomName: string;
  /** The DOCX the room was seeded from. */
  seedDocx: Uint8Array;
};

type CreateRoomAuthoritiesOptions = {
  clock?: LeaseClock;
  coordination: RoomAuthorityCoordination;
  leaseDriftMs?: number;
  leaseRenewMs?: number;
  leaseTtlMs?: number;
};

type LeaseTiming = {
  clock: LeaseClock;
  leaseDriftMs: number;
  leaseRenewMs: number;
  leaseTtlMs: number;
};

const leaseKey = (roomName: string, keyPrefix: string) =>
  `${keyPrefix}:authority:${roomName}`;

/** Give the room's lease back; one that cannot be given back expires. */
const releaseLease = async (
  coordination: RedisCoordination,
  roomName: string,
  roomId: string,
) => {
  const released = await Result.tryPromise({
    try: async () =>
      await coordination.redis.eval(
        RELEASE_LEASE,
        1,
        leaseKey(roomName, coordination.keyPrefix),
        coordination.holder,
      ),
    catch: (cause) => cause,
  });
  if (Result.isError(released)) {
    logCollabEvent({
      event: "room_authority_lease_release_failed",
      level: "warn",
      roomId,
    });
  }
};

/** The role a started room settled in, or why it cannot run. */
const settledRole = (
  state: RoomAuthorityState,
): Result<RoomAuthorityRole, RoomAuthorityStartError> => {
  switch (state.type) {
    case "serving":
    case "relaying":
    case "stopped":
      return Result.ok(state.type);
    case "failed":
      return Result.err(state.error);
    case "opening":
      return panic("A started room authority is still opening");
    default: {
      state satisfies never;
      return panic("Unhandled room authority state");
    }
  }
};

type KeepLeaseOptions = LeaseTiming & {
  coordination: RedisCoordination;
  room: RunningRoom;
  roomName: string;
  /** Start serving the room, or retire it as failed. */
  serve: () => Promise<void>;
};

/**
 * Hold the room's lease while the room runs: serve while it is valid, relay
 * while another instance has it. Settles once the first request is answered.
 */
const keepLease = async ({
  clock,
  coordination,
  leaseDriftMs,
  leaseRenewMs,
  leaseTtlMs,
  room,
  roomName,
  serve,
}: KeepLeaseOptions) => {
  const key = leaseKey(roomName, coordination.keyPrefix);
  /** Stop serving: the lease can no longer be shown to be this instance's. */
  const relay = (
    event: "room_authority_lease_expired" | "room_authority_lease_lost",
  ) => {
    room.deadline?.abort();
    room.deadline = undefined;
    if (room.state.type !== "serving") {
      return;
    }
    room.state.authority.stop();
    room.state = { type: "relaying" };
    logCollabEvent({ event, level: "warn", roomId: room.roomId });
  };
  const watchDeadline = (validUntil: number) => {
    room.deadline?.abort();
    const deadline = new AbortController();
    room.deadline = deadline;
    void clock
      .sleep(Math.max(0, validUntil - clock.monotonic()), {
        signal: deadline.signal,
      })
      .then(
        () => relay("room_authority_lease_expired"),
        // A later grant or a stop superseded this deadline.
        () => undefined,
      );
  };
  const renew = async () => {
    const requestedAt = clock.monotonic();
    const acquired = await Result.tryPromise({
      try: async () =>
        await coordination.redis.eval(
          ACQUIRE_LEASE,
          1,
          key,
          coordination.holder,
          leaseTtlMs,
        ),
      catch: (cause) => cause,
    });
    // Redis set the lease's expiry after this request left, so the lease is
    // this instance's at least until then; a later grant is not.
    const validUntil = requestedAt + leaseTtlMs - leaseDriftMs;
    const holds =
      Result.isOk(acquired) &&
      acquired.value === 1 &&
      clock.monotonic() < validUntil;
    switch (room.state.type) {
      case "opening":
      case "relaying":
        if (!holds) {
          room.state = { type: "relaying" };
          return;
        }
        await serve();
        break;
      case "serving":
        if (!holds) {
          relay("room_authority_lease_lost");
          return;
        }
        break;
      case "failed":
      case "stopped":
        return;
      default: {
        room.state satisfies never;
        panic("Unhandled room authority state");
      }
    }
    if (room.state.type === "serving") {
      watchDeadline(validUntil);
    }
  };
  const renewWhileRunning = async () => {
    const { signal } = room.retired;
    while (!signal.aborted) {
      const waited = await Result.tryPromise({
        try: async () => await clock.sleep(leaseRenewMs, { signal }),
        catch: (cause) => cause,
      });
      if (Result.isError(waited)) {
        return;
      }
      // `renew` settles every failure itself.
      await renew();
    }
  };
  await renew();
  void renewWhileRunning();
};

export const createRoomAuthorities = ({
  clock = systemLeaseClock,
  coordination,
  leaseDriftMs = LEASE_DRIFT_MS,
  leaseRenewMs = LEASE_RENEW_MS,
  leaseTtlMs = LEASE_TTL_MS,
}: CreateRoomAuthoritiesOptions) => {
  const rooms = new Map<string, RunningRoom>();

  /** Stop the room's renewals and its authority, and give its lease back. */
  const retire = async (
    roomName: string,
    room: RunningRoom,
    next: Extract<RoomAuthorityState, { type: "failed" | "stopped" }>,
  ) => {
    if (rooms.get(roomName) === room) {
      rooms.delete(roomName);
    }
    room.retired.abort();
    room.deadline?.abort();
    room.deadline = undefined;
    const held = room.state;
    room.state = next;
    if (held.type === "serving") {
      held.authority.stop();
    }
    if (coordination.type === "redis") {
      await releaseLease(coordination, roomName, room.roomId);
    }
  };

  const stop = async (roomName: string) => {
    const room = rooms.get(roomName);
    if (room === undefined) {
      return;
    }
    await retire(roomName, room, { type: "stopped" });
  };

  const start = async ({
    doc,
    roomId,
    roomName,
    seedDocx,
  }: StartRoomAuthorityOptions): Promise<
    Result<RoomAuthorityRole, RoomAuthorityStartError>
  > => {
    await stop(roomName);
    const room: RunningRoom = {
      roomId,
      state: { type: "opening" },
      retired: new AbortController(),
      deadline: undefined,
    };
    rooms.set(roomName, room);
    const fail = async (reason: string) => {
      const error = new RoomAuthorityStartError({
        message: "The room's authority cannot run.",
        reason,
      });
      logCollabEvent({
        event: "room_authority_failed",
        level: "error",
        reason,
        roomId,
      });
      await retire(roomName, room, { type: "failed", error });
    };
    const base = await Result.tryPromise({
      try: async () =>
        await FolioDocxReviewer.openRoomBase(seedDocx.slice().buffer),
      catch: (cause) => cause,
    });
    if (room.state.type === "stopped") {
      return Result.ok("stopped");
    }
    if (Result.isError(base)) {
      await fail("seedUnreadable");
      return settledRole(room.state);
    }

    const serve = async () => {
      const served = serveCanonicalYjsRoom({
        doc,
        snapshot: base.value.snapshot,
        document: base.value.document,
        onError: (error) =>
          logCollabEvent({
            event: "room_authority_refused_entry",
            level: "warn",
            reason: error.reason,
            roomId,
          }),
      });
      if (Result.isError(served)) {
        await fail(served.error.reason);
        return;
      }
      room.state = { type: "serving", authority: served.value };
    };

    if (coordination.type === "single-process") {
      await serve();
    } else {
      await keepLease({
        clock,
        coordination,
        leaseDriftMs,
        leaseRenewMs,
        leaseTtlMs,
        room,
        roomName,
        serve,
      });
    }
    return settledRole(room.state);
  };

  /** What this instance does for the room now, if it runs it. */
  const roleOf = (roomName: string) => rooms.get(roomName)?.state.type;

  const stopAll = async () => {
    await Promise.all([...rooms.keys()].map(async (name) => await stop(name)));
  };

  return { roleOf, start, stop, stopAll };
};
