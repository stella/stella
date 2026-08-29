/**
 * SSE publish against a peer that answered once and then stopped replying.
 *
 * `redis-outage.test.ts` covers the refused-connection outage, which the
 * publisher's `connectionTimeout` bounds and which `enableOfflineQueue: false`
 * turns into an immediate rejection. This is the outage neither option can
 * see: the socket is established and healthy from the client's side, so no
 * connect timer is armed and nothing is queued offline, yet a partitioned or
 * paused peer never answers the PUBLISH. Against the real client that promise
 * stays pending indefinitely, which would strand the desktop-edit-session
 * expiry task, since it awaits its publish before stamping the notification
 * column and only then releases its lease.
 *
 * Its own file because it owns a local peer that intentionally leaves one
 * command pending until the publisher timeout expires.
 */

import { RedisClient } from "bun";
import { afterAll, describe, expect, test } from "bun:test";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";

let peerAnswers = true;

// Speaks just enough RESP to complete a handshake and acknowledge a PUBLISH,
// so the client reaches a genuinely connected state. Once `peerAnswers` flips,
// PUBLISH gets no reply: the connection stays open and the command has nothing
// to settle against, which is the failure under test.
const partitionedPeer = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    data(socket, data) {
      const isPublish = data.toString().includes("PUBLISH");
      if (isPublish && !peerAnswers) {
        return;
      }
      socket.write(isPublish ? ":0\r\n" : "+OK\r\n");
    },
  },
});

const { createSseBroadcastPublisher, SSEBroadcastError } =
  await import("@/api/lib/sse-broadcast");
const { publishWorkspaceEvent } = createSseBroadcastPublisher({
  createClient: (options) =>
    new RedisClient(`redis://127.0.0.1:${partitionedPeer.port}`, options),
});
const { resourceUpdatedRealtimeEvent } = await import("@stll/api-contract");
const { brandPersistedWorkspaceId, brandPersistedEntityId } =
  await import("@/api/lib/safe-id-boundaries");

const WORKSPACE_ID = brandPersistedWorkspaceId(
  "01931f4a-0000-7000-8000-000000000001",
);
const EVENT = resourceUpdatedRealtimeEvent(
  resourceRef({
    type: RESOURCE_TYPE.ENTITY,
    id: brandPersistedEntityId("01931f4a-0000-7000-8000-000000000002"),
  }),
);

// Well above the publisher's 2s command timeout, so a merely slow publish
// still passes while one that never settles fails this test instead of
// hanging the batch.
const PUBLISH_DEADLINE_MS = 15_000;

const CONNECT_POLL_MS = 50;
const CONNECT_ATTEMPTS = 40;

/**
 * The publisher disables the offline queue, so a command issued before the
 * client finishes connecting rejects at once while it connects in the
 * background. Publish until one succeeds, so the command under test is issued
 * on a live socket: a publish rejected for being offline would pass this test
 * for entirely the wrong reason.
 */
const publishUntilConnected = async (attemptsLeft: number): Promise<void> => {
  const published = await publishWorkspaceEvent(WORKSPACE_ID, EVENT).then(
    () => true,
    () => false,
  );
  if (published) {
    return;
  }
  if (attemptsLeft <= 1) {
    throw new Error("the publisher never reached the local peer");
  }
  await Bun.sleep(CONNECT_POLL_MS);
  await publishUntilConnected(attemptsLeft - 1);
};

afterAll(() => {
  partitionedPeer.stop(true);
});

describe("SSE publish against a peer that stops replying", () => {
  test(
    "rejects on the command timeout instead of waiting on the peer forever",
    async () => {
      await publishUntilConnected(CONNECT_ATTEMPTS);
      peerAnswers = false;

      const rejection = await publishWorkspaceEvent(WORKSPACE_ID, EVENT).then(
        () => null,
        (error: unknown) => error,
      );

      expect(SSEBroadcastError.is(rejection)).toBe(true);
    },
    PUBLISH_DEADLINE_MS,
  );
});
