import {
  afterAll,
  beforeAll,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";

import {
  type DesktopEditSessionRealtimeEvent,
  newNotificationRealtimeEvent,
  type OrganizationRealtimeEvent,
  parseDesktopEditSessionRealtimeEvent,
  parseOrganizationRealtimeEvent,
  parseUserRealtimeEvent,
  parseWorkspaceRealtimeEvent,
  REALTIME_CHANNEL_EVENT_TYPES,
  REALTIME_EVENT_TYPE,
  type RealtimeChannel,
  RESOURCE_TYPE,
  resourceDeletedRealtimeEvent,
  resourceRef,
  resourcesChangedRealtimeEvent,
  resourceSetUpdatedRealtimeEvent,
  resourceUpdatedChange,
  resourceUpdatedRealtimeEvent,
  type UserRealtimeEvent,
  type WorkspaceRealtimeEvent,
} from "@stll/api-contract";

import { member, organization, session, user } from "@/api/db/auth-schema";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import { desktopEditSessionEventsHandler } from "@/api/handlers/entities/desktop-edit-session-events";
import { realtimeAuthorizers } from "@/api/lib/auth";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  queryCountLogger,
  runWithQueryCounter,
} from "@/api/lib/db-query-counter";
import {
  desktopEditSessionCloseSignal,
  isDesktopEditSessionCloseSignal,
} from "@/api/lib/desktop-edit-session-notifications";
import {
  broadcast,
  broadcastSessionEvent,
  broadcastToOrganization,
  broadcastToUser,
  startSse,
  stopSse,
  subscribe,
  subscribeUser,
} from "@/api/lib/sse";
import { createSseBroadcastPublisher } from "@/api/lib/sse-broadcast";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// What one live-update publish costs as its audience grows. Every event kind a
// channel carries (read off the channel's own schema in the contract) is
// published to 1 and to 50 entitled subscribers on one API instance, through
// the attached-subscriber path production runs: publish, Redis loopback,
// reauthorization against the real database, local fan-out. The cost of a
// publish must not depend on how many tabs are listening: the database
// statements are the same at 1 and at 50 (the audience is reauthorized in one
// batch, never per stream), the event is encoded into one SSE frame that every
// stream shares, and every stream receives the same bytes. Subscribers outside
// the audience (another organization, another user, another session) receive
// nothing, and excluding them adds no statement.

setDefaultTimeout(120_000);

const LARGE_AUDIENCE = 50;

// ── Census ────────────────────────────────────────────────

type ChannelEvent = {
  organization: OrganizationRealtimeEvent;
  session: DesktopEditSessionRealtimeEvent;
  user: UserRealtimeEvent;
  workspace: WorkspaceRealtimeEvent;
};

const entity = resourceRef({
  type: RESOURCE_TYPE.ENTITY,
  id: toSafeId<"entity">("0199c0de-0000-7000-8000-00000000f001"),
});

/**
 * One publishable event per kind and channel; the census below fails until a
 * new kind has its case here. There is no opt-out list: every kind, the
 * session close signal included, is measured.
 */
const FANOUT_CASES: { [C in RealtimeChannel]: readonly ChannelEvent[C][] } = {
  workspace: [
    resourceUpdatedRealtimeEvent(entity),
    resourceDeletedRealtimeEvent(entity),
    resourcesChangedRealtimeEvent([resourceUpdatedChange(entity)]),
    resourceSetUpdatedRealtimeEvent(RESOURCE_TYPE.ENTITY),
    {
      type: REALTIME_EVENT_TYPE.WORKFLOW_EXTRACTION_PREVIEW,
      data: {
        entityId: "entity-1",
        entityVersionId: "entity-version-1",
        propertyId: "property-1",
        answer: "Draft answer",
        status: "streaming",
      },
    },
    {
      type: REALTIME_EVENT_TYPE.FLOW_RUN_UPDATE,
      data: {
        runId: "run-1",
        status: "running",
        currentStepIndex: 0,
        steps: [{ index: 0, status: "running" }],
      },
    },
  ],
  organization: [resourceSetUpdatedRealtimeEvent(RESOURCE_TYPE.ENTITY)],
  user: [newNotificationRealtimeEvent()],
  session: [
    {
      type: REALTIME_EVENT_TYPE.TAKEOVER_REQUESTED,
      data: {
        requestedBy: "Another user",
        requestedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    {
      type: REALTIME_EVENT_TYPE.SESSION_TAKEN_OVER,
      data: { message: "Taken over" },
    },
    {
      type: REALTIME_EVENT_TYPE.SESSION_CLOSED,
      data: { reason: "expired" },
    },
    desktopEditSessionCloseSignal(),
  ],
};

const CHANNEL_PARSERS: {
  [C in RealtimeChannel]: (input: unknown) => ChannelEvent[C] | null;
} = {
  organization: parseOrganizationRealtimeEvent,
  session: parseDesktopEditSessionRealtimeEvent,
  user: parseUserRealtimeEvent,
  workspace: parseWorkspaceRealtimeEvent,
};

const CHANNELS = Object.keys(REALTIME_CHANNEL_EVENT_TYPES).filter(
  (channel): channel is RealtimeChannel => channel in FANOUT_CASES,
);

const sorted = (values: Iterable<string>): string[] => [...values].toSorted();

describe("live-update fan-out census", () => {
  test("covers exactly the channels the contract declares", () => {
    expect(sorted(Object.keys(FANOUT_CASES))).toEqual(
      sorted(Object.keys(REALTIME_CHANNEL_EVENT_TYPES)),
    );
  });

  test("every event kind is carried by some channel", () => {
    const carried = new Set<string>(
      Object.values(REALTIME_CHANNEL_EVENT_TYPES).flat(),
    );
    expect(sorted(carried)).toEqual(sorted(Object.values(REALTIME_EVENT_TYPE)));
  });

  test.each(CHANNELS)(
    "every %s event kind has exactly one fan-out case",
    (channel) => {
      const events: readonly ChannelEvent[RealtimeChannel][] =
        FANOUT_CASES[channel];
      const cased = events.map((event) => event.type);

      expect(new Set(cased).size).toBe(cased.length);
      expect(sorted(cased)).toEqual(
        sorted(REALTIME_CHANNEL_EVENT_TYPES[channel]),
      );
    },
  );

  test.each(CHANNELS)(
    "every %s fan-out case is an event its channel accepts",
    (channel) => {
      const parse: (input: unknown) => unknown = CHANNEL_PARSERS[channel];
      for (const event of FANOUT_CASES[channel]) {
        expect(parse(event)).toEqual(event);
      }
    },
  );
});

// ── Harness ───────────────────────────────────────────────

let testDb: TestDatabase;

/** Redis stand-in: a publish reaches every attached subscriber callback. */
const subscriberCallbacks = new Set<(message: string) => void>();
let redisPublishes = 0;

type FakeSubscriberClient = {
  close: ReturnType<typeof mock>;
  connected: boolean;
  onReconnect: ReturnType<typeof mock>;
  subscribe: ReturnType<typeof mock>;
};

const createFakeSubscriber = (): FakeSubscriberClient => {
  const client: FakeSubscriberClient = {
    close: mock(() => {
      client.connected = false;
    }),
    connected: false,
    onReconnect: mock(() => () => undefined),
    subscribe: mock(
      async (_channel: string, callback: (message: string) => void) => {
        subscriberCallbacks.add(callback);
        client.connected = true;
      },
    ),
  };
  return client;
};

const loopbackPublisher = createSseBroadcastPublisher({
  createClient: () => ({
    publish: async (_channel, message) => {
      redisPublishes += 1;
      for (const deliver of subscriberCallbacks) {
        deliver(message);
      }
      return subscriberCallbacks.size;
    },
  }),
});

type Audience = {
  organizationId: SafeId<"organization">;
  userIds: SafeId<"user">[];
  workspaceId: SafeId<"workspace">;
};

/** Each seeded member's live sign-in; every stream is opened on it. */
const sessionOf = new Map<SafeId<"user">, string>();

const sessionFor = (userId: SafeId<"user">): string => {
  const sessionId = sessionOf.get(userId);
  if (sessionId === undefined) {
    throw new Error(`No session was seeded for ${userId}`);
  }
  return sessionId;
};

/**
 * One organization with one matter and `size` members assigned to it, each
 * signed in on one live session.
 */
const seedAudience = async (size: number): Promise<Audience> => {
  const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
  const workspaceId = createSafeId<"workspace">();
  const userIds = Array.from({ length: size }, () =>
    toSafeId<"user">(`user_${Bun.randomUUIDv7()}`),
  );
  await testDb.insert(organization).values({
    id: organizationId,
    name: "Fan-out",
    slug: `fan-out-${organizationId.slice(-12)}`,
    createdAt: new Date(),
  });
  await testDb.insert(user).values(
    userIds.map((id) => ({
      id,
      name: "Member",
      email: `${id}@fan-out.test`,
      emailVerified: true,
    })),
  );
  const sessions = userIds.map((userId) => ({
    id: `session_${Bun.randomUUIDv7()}`,
    token: Bun.randomUUIDv7(),
    userId,
    expiresAt: new Date(Date.now() + 86_400_000),
  }));
  await testDb.insert(session).values(sessions);
  for (const row of sessions) {
    sessionOf.set(row.userId, row.id);
  }
  await testDb.insert(member).values(
    userIds.map((userId) => ({
      id: Bun.randomUUIDv7(),
      organizationId,
      userId,
      role: "member",
      createdAt: new Date(),
    })),
  );
  await testDb.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Fan-out",
    reference: `FO-${workspaceId.slice(-6)}`,
    status: "active",
  });
  await testDb.insert(workspaceMembers).values(
    userIds.map((userId) => ({
      id: createSafeId<"workspaceMember">(),
      workspaceId,
      userId,
    })),
  );
  return { organizationId, userIds, workspaceId };
};

let audience: Audience;
let otherOrganization: Audience;

beforeAll(async () => {
  testDb = await initAgentAuthTestDb({ logger: queryCountLogger });
  startSse(realtimeAuthorizers, {
    createClient: createFakeSubscriber,
    publisher: loopbackPublisher,
  });
  audience = await seedAudience(LARGE_AUDIENCE);
  otherOrganization = await seedAudience(LARGE_AUDIENCE);
  // Measure the path production runs: an attached subscriber, so every
  // publish comes back through the Redis loopback rather than inline.
  expect(subscriberCallbacks.size).toBe(1);
});

afterAll(async () => {
  stopSse();
  await releaseAgentAuthTestDb();
});

const userAt = (target: Audience, index: number): SafeId<"user"> => {
  const userId = target.userIds.at(index);
  if (userId === undefined) {
    throw new Error(`The audience has no member at ${index}`);
  }
  return userId;
};

type WorkspaceStreamsOptions = {
  target: Audience;
  count: number;
  signal: AbortSignal;
  workspaceId?: SafeId<"workspace">;
};

const workspaceStreams = ({
  target,
  count,
  signal,
  workspaceId = target.workspaceId,
}: WorkspaceStreamsOptions) =>
  Array.from({ length: count }, (_unused, index) =>
    subscribe({
      organizationId: target.organizationId,
      sessionId: sessionFor(userAt(target, index)),
      signal,
      userId: userAt(target, index),
      workspaceId,
    }),
  );

type UserStreamsOptions = {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  count: number;
  signal: AbortSignal;
};

const userStreams = ({
  userId,
  organizationId,
  count,
  signal,
}: UserStreamsOptions) =>
  Array.from({ length: count }, () =>
    subscribeUser({
      organizationId,
      sessionId: sessionFor(userId),
      signal,
      userId,
    }),
  );

const sessionDependencies = () => {
  const authorize = mock();
  const readEventState = mock();
  const refreshLiveness = mock();
  authorize.mockResolvedValue({
    status: "authorized",
    value: {
      scopedDb: async <T>(fn: (tx: object) => Promise<T>) => await fn({}),
      userId: userAt(audience, 0),
    },
  });
  readEventState.mockResolvedValue({ pendingRequest: null });
  refreshLiveness.mockResolvedValue(true);
  return {
    authorizeDesktopEditSession: authorize,
    livenessRefreshIntervalMs: 3_600_000,
    readDesktopEditSessionEventState: readEventState,
    refreshDesktopEditSessionLiveness: refreshLiveness,
  };
};

const CONNECTED_COMMENT = ": connected\n\n";

/** Open `count` desktop-edit event streams, past their connect comment. */
const sessionStreams = async (
  sessionId: SafeId<"desktopEditSession">,
  count: number,
): Promise<ReadableStream<Uint8Array>[]> =>
  await Promise.all(
    Array.from({ length: count }, async () => {
      const response = await desktopEditSessionEventsHandler(
        {
          headers: { authorization: `Bearer ${"a".repeat(64)}` },
          sessionId,
        },
        sessionDependencies(),
      );
      if (!(response instanceof Response) || !response.body) {
        throw new Error("The desktop edit session did not open a stream");
      }
      const reader = response.body.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe(CONNECTED_COMMENT);
      reader.releaseLock();
      return response.body;
    }),
  );

type Delivery = "closed" | "frame" | "silent";

type Subscribers = {
  entitled: ReadableStream<Uint8Array>[];
  excluded: ReadableStream<Uint8Array>[];
};

type ChannelHarness<C extends RealtimeChannel> = {
  /** Statements one publish may issue, whatever the audience size. */
  statementsPerPublish: number;
  open: (
    shape: { entitled: number; excluded: boolean },
    signal: AbortSignal,
  ) => Promise<Subscribers>;
  /** What an entitled stream receives for the event. */
  delivery: (event: ChannelEvent[C]) => Exclude<Delivery, "silent">;
  publish: (event: ChannelEvent[C]) => void;
};

const audienceSession = createSafeId<"desktopEditSession">();
const otherSession = createSafeId<"desktopEditSession">();

const HARNESSES: { [C in RealtimeChannel]: ChannelHarness<C> } = {
  // The matter's members, reauthorized in one batch per publish. Excluded:
  // another organization's members on their own matter, and the same
  // organization's outsiders holding a stream on this matter (closed).
  workspace: {
    statementsPerPublish: 1,
    delivery: () => "frame",
    open: async ({ entitled, excluded }, signal) => ({
      entitled: workspaceStreams({ target: audience, count: entitled, signal }),
      excluded: excluded
        ? [
            ...workspaceStreams({
              target: otherOrganization,
              count: LARGE_AUDIENCE,
              signal,
            }),
            ...workspaceStreams({
              target: otherOrganization,
              count: LARGE_AUDIENCE,
              signal,
              workspaceId: audience.workspaceId,
            }),
          ]
        : [],
    }),
    publish: (event) => {
      broadcast(audience.workspaceId, event);
    },
  },
  // Every open matter stream of the organization; the event carries no
  // content, so it reaches them without a membership read.
  organization: {
    statementsPerPublish: 0,
    delivery: () => "frame",
    open: async ({ entitled, excluded }, signal) => ({
      entitled: workspaceStreams({ target: audience, count: entitled, signal }),
      excluded: excluded
        ? workspaceStreams({
            target: otherOrganization,
            count: LARGE_AUDIENCE,
            signal,
          })
        : [],
    }),
    publish: (event) => {
      broadcastToOrganization(audience.organizationId, event);
    },
  },
  // Every tab one member has open on the organization, one membership read.
  // Excluded: the same person's tabs on another organization, and another
  // member's tabs.
  user: {
    statementsPerPublish: 1,
    delivery: () => "frame",
    open: async ({ entitled, excluded }, signal) => ({
      entitled: userStreams({
        userId: userAt(audience, 0),
        organizationId: audience.organizationId,
        count: entitled,
        signal,
      }),
      excluded: excluded
        ? [
            ...userStreams({
              userId: userAt(audience, 0),
              organizationId: otherOrganization.organizationId,
              count: LARGE_AUDIENCE,
              signal,
            }),
            ...userStreams({
              userId: userAt(audience, 1),
              organizationId: audience.organizationId,
              count: LARGE_AUDIENCE,
              signal,
            }),
          ]
        : [],
    }),
    publish: (event) => {
      broadcastToUser(userAt(audience, 0), audience.organizationId, event);
    },
  },
  // Every desktop client attached to one edit session; the close signal ends
  // their streams instead of writing a frame. Excluded: another session's
  // clients.
  session: {
    statementsPerPublish: 0,
    delivery: (event) =>
      isDesktopEditSessionCloseSignal(event) ? "closed" : "frame",
    open: async ({ entitled, excluded }) => ({
      entitled: await sessionStreams(audienceSession, entitled),
      excluded: excluded
        ? await sessionStreams(otherSession, LARGE_AUDIENCE)
        : [],
    }),
    publish: (event) => {
      broadcastSessionEvent(audienceSession, event);
    },
  },
};

const harnessFor = <C extends RealtimeChannel>(channel: C): ChannelHarness<C> =>
  HARNESSES[channel];

/**
 * What a stream holds once the publish has been delivered: delivery to the
 * audience is one synchronous pass after the batch reauthorization, so a frame
 * meant for a stream is already queued when the audience has read theirs.
 */
const pendingDelivery = async (reader: {
  read: () => PromiseLike<{ done: boolean }>;
}): Promise<Delivery> =>
  await Promise.race([
    reader.read().then(({ done }): Delivery => (done ? "closed" : "frame")),
    Bun.sleep(0).then((): Delivery => "silent"),
  ]);

const isSseFrameEncode = ([input]: unknown[]): boolean =>
  typeof input === "string" && input.startsWith("data: ");

type FanoutMeasurement = {
  /** What each entitled stream received: a frame, or the end of the stream. */
  entitled: Exclude<Delivery, "silent">[];
  excluded: Delivery[];
  frames: Uint8Array[];
  redisPublishes: number;
  sseFrameEncodes: number;
  statements: number;
};

type MeasurePublishOptions<C extends RealtimeChannel> = {
  channel: C;
  event: ChannelEvent[C];
  shape: { entitled: number; excluded: boolean };
};

const measurePublish = async <C extends RealtimeChannel>({
  channel,
  event,
  shape,
}: MeasurePublishOptions<C>): Promise<FanoutMeasurement> => {
  const harness = harnessFor(channel);
  const controller = new AbortController();
  const subscribers = await harness.open(shape, controller.signal);
  const entitled = subscribers.entitled.map((stream) => stream.getReader());
  const excluded = subscribers.excluded.map((stream) => stream.getReader());
  const publishesBefore = redisPublishes;
  const encode = spyOn(TextEncoder.prototype, "encode");
  try {
    const { reads, statements } = await runWithQueryCounter(async (counter) => {
      harness.publish(event);
      const received = await Promise.all(
        entitled.map(async (reader) => await reader.read()),
      );
      return { reads: received, statements: counter.count };
    });
    const sseFrameEncodes = encode.mock.calls.filter(isSseFrameEncode).length;
    return {
      entitled: reads.map(({ done }) => (done ? "closed" : "frame")),
      excluded: await Promise.all(excluded.map(pendingDelivery)),
      frames: reads.flatMap(({ value }) =>
        value === undefined ? [] : [value],
      ),
      redisPublishes: redisPublishes - publishesBefore,
      sseFrameEncodes,
      statements,
    };
  } finally {
    encode.mockRestore();
    controller.abort();
    await Promise.all(
      [...entitled, ...excluded].map(async (reader) => {
        // swallow-ok: teardown of a stream the measurement already read or closed
        await reader.cancel().catch(() => undefined);
      }),
    );
  }
};

const fanoutCases = CHANNELS.flatMap((channel) => {
  const events: readonly ChannelEvent[RealtimeChannel][] =
    FANOUT_CASES[channel];
  return events.map((event) => ({ channel, event }));
});

/**
 * One publish went out to Redis once, and reached each entitled stream as
 * the kind's delivery: one encoded frame every stream shares, or the end of
 * every stream with nothing encoded.
 */
type ExpectDeliveredOnceOptions = {
  measurement: FanoutMeasurement;
  delivery: Exclude<Delivery, "silent">;
  audienceSize: number;
};

const expectDeliveredOnce = ({
  measurement,
  delivery,
  audienceSize,
}: ExpectDeliveredOnceOptions): void => {
  expect(measurement.redisPublishes).toBe(1);
  expect(measurement.entitled).toEqual(
    Array.from({ length: audienceSize }, () => delivery),
  );
  if (delivery === "closed") {
    expect(measurement.sseFrameEncodes).toBe(0);
    return;
  }
  expect(measurement.sseFrameEncodes).toBe(1);
  expect(new Set(measurement.frames).size).toBe(1);
};

describe("one live-update publish costs the same for 1 and for 50 subscribers", () => {
  test.each(fanoutCases)("$channel $event.type", async ({ channel, event }) => {
    const harness = harnessFor(channel);
    const delivery = harness.delivery(event);
    const single = await measurePublish({
      channel,
      event,
      shape: {
        entitled: 1,
        excluded: false,
      },
    });
    const many = await measurePublish({
      channel,
      event,
      shape: {
        entitled: LARGE_AUDIENCE,
        excluded: false,
      },
    });

    expect(single.statements).toBe(harness.statementsPerPublish);
    expect(many.statements).toBe(single.statements);
    expectDeliveredOnce({ measurement: single, delivery, audienceSize: 1 });
    expectDeliveredOnce({
      measurement: many,
      delivery,
      audienceSize: LARGE_AUDIENCE,
    });
    const frameBytes = single.frames.map((frame) => frame.byteLength);
    expect(frameBytes.every((bytes) => bytes > 0)).toBe(true);
    if (delivery === "closed") {
      expect(single.frames).toEqual([]);
      expect(many.frames).toEqual([]);
    } else {
      const frameByteLength = frameBytes.at(0);
      expect(frameByteLength).toBeDefined();
      if (frameByteLength === undefined) {
        throw new Error("Expected the single subscriber to receive a frame");
      }
      expect(many.frames.map((frame) => frame.byteLength)).toEqual(
        many.frames.map(() => frameByteLength),
      );
    }
  });

  test.each(fanoutCases)(
    "$channel $event.type reaches no one outside its audience, at no extra statement",
    async ({ channel, event }) => {
      const harness = harnessFor(channel);
      const measurement = await measurePublish({
        channel,
        event,
        shape: {
          entitled: 1,
          excluded: true,
        },
      });

      expect(measurement.excluded.length).toBeGreaterThanOrEqual(
        LARGE_AUDIENCE,
      );
      expect(
        measurement.excluded.filter((outcome) => outcome === "frame"),
      ).toEqual([]);
      expect(measurement.statements).toBe(harness.statementsPerPublish);
      expectDeliveredOnce({
        measurement,
        delivery: harness.delivery(event),
        audienceSize: 1,
      });
    },
  );
});
