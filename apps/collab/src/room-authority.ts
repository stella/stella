import { panic, Result } from "better-result";
import type { Cluster, Redis } from "ioredis";
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
 * others relay. An instance that cannot renew its lease stops serving before
 * the lease expires, so two authorities never write one journal.
 */

const LEASE_TTL_MS = 15_000;
const LEASE_RENEW_MS = 5000;

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

/** Who runs a room's authority: this process alone, or a Redis lease's holder. */
export type RoomAuthorityCoordination =
  | { type: "single-process" }
  | {
      type: "redis";
      redis: Redis | Cluster;
      /** Prefix of the lease keys; the room name keeps them in its slot. */
      keyPrefix: string;
      /** This instance's identity as a lease holder. */
      holder: string;
    };

type RoomAuthorityState =
  | { type: "opening" }
  | { type: "relaying" }
  | { type: "serving"; authority: CanonicalYjsAuthority }
  | { type: "failed" }
  | { type: "stopped" };

type RunningRoom = {
  state: RoomAuthorityState;
  timer: ReturnType<typeof setInterval> | undefined;
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
  coordination: RoomAuthorityCoordination;
  leaseRenewMs?: number;
  leaseTtlMs?: number;
};

export const createRoomAuthorities = ({
  coordination,
  leaseRenewMs = LEASE_RENEW_MS,
  leaseTtlMs = LEASE_TTL_MS,
}: CreateRoomAuthoritiesOptions) => {
  const rooms = new Map<string, RunningRoom>();
  const leaseKey = (roomName: string, keyPrefix: string) =>
    `${keyPrefix}:authority:${roomName}`;

  const stop = async (roomName: string) => {
    const room = rooms.get(roomName);
    if (room === undefined) {
      return;
    }
    rooms.delete(roomName);
    clearInterval(room.timer);
    const held = room.state;
    room.state = { type: "stopped" };
    if (held.type === "serving") {
      held.authority.stop();
    }
    if (coordination.type === "redis") {
      // A release that fails leaves the lease to expire.
      await Result.tryPromise({
        try: async () =>
          await coordination.redis.eval(
            RELEASE_LEASE,
            1,
            leaseKey(roomName, coordination.keyPrefix),
            coordination.holder,
          ),
        catch: (cause) => cause,
      });
    }
  };

  const start = async ({
    doc,
    roomId,
    roomName,
    seedDocx,
  }: StartRoomAuthorityOptions) => {
    await stop(roomName);
    const room: RunningRoom = { state: { type: "opening" }, timer: undefined };
    rooms.set(roomName, room);
    const base = await Result.tryPromise({
      try: async () =>
        await FolioDocxReviewer.openRoomBase(seedDocx.slice().buffer),
      catch: (cause) => cause,
    });
    if (room.state.type === "stopped") {
      return;
    }
    if (Result.isError(base)) {
      room.state = { type: "failed" };
      logCollabEvent({
        event: "room_authority_failed",
        level: "error",
        reason: "seedUnreadable",
        roomId,
      });
      return;
    }

    const serve = (): RoomAuthorityState => {
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
        logCollabEvent({
          event: "room_authority_failed",
          level: "error",
          reason: served.error.reason,
          roomId,
        });
        return { type: "failed" };
      }
      return { type: "serving", authority: served.value };
    };

    if (coordination.type === "single-process") {
      room.state = serve();
      return;
    }

    const key = leaseKey(roomName, coordination.keyPrefix);
    const renew = async () => {
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
      const holds = Result.isOk(acquired) && acquired.value === 1;
      switch (room.state.type) {
        case "opening":
        case "relaying":
          room.state = holds ? serve() : { type: "relaying" };
          return;
        case "serving":
          if (!holds) {
            room.state.authority.stop();
            room.state = { type: "relaying" };
            logCollabEvent({
              event: "room_authority_lease_lost",
              level: "warn",
              roomId,
            });
          }
          return;
        case "failed":
        case "stopped":
          return;
        default: {
          room.state satisfies never;
          return panic("Unhandled room authority state");
        }
      }
    };
    // `renew` settles every failure itself.
    room.timer = setInterval(() => {
      void renew();
    }, leaseRenewMs);
    await renew();
  };

  const stopAll = async () => {
    await Promise.all([...rooms.keys()].map(async (name) => await stop(name)));
  };

  return { start, stop, stopAll };
};
