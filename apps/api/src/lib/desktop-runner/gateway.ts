import { Result } from "better-result";
import * as v from "valibot";

import {
  DESKTOP_RUNNER_LIMITS,
  type DesktopRunnerLimits,
} from "@stll/api-contract/desktop-runner";

import type { HttpServer } from "@/api/http/context";
import { detached } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import type { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import {
  type DesktopKeyLiveness,
  desktopKeyLiveness,
} from "@/api/lib/business-registries/desktop/liveness";
import type { DesktopRunnerDoorbell } from "@/api/lib/desktop-runner/doorbell";
import {
  DESKTOP_RUNNER_DESKTOP_ID_HEADER,
  DESKTOP_RUNNER_TIMING,
  type DesktopRunnerTiming,
} from "@/api/lib/desktop-runner/protocol";
import {
  createRunnerSession,
  type MintRunToken,
  type RunnerSession,
  type RunnerTimers,
  SYSTEM_TIMERS,
} from "@/api/lib/desktop-runner/session";
import {
  type DesktopRunnerDb,
  expireAbandonedRuns,
  expireRunLeases,
  pruneEndedRuns,
  readSessionsWithQueuedCommands,
} from "@/api/lib/desktop-runner/store";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

const LEASE_SWEEP_SINK = failureSink({
  event: "desktop_runner.lease_sweep_failed",
  expected: [],
});

/** Who an authenticated upgrade request belongs to. */
type DesktopRunnerCaller = {
  readonly userId: SafeId<"user">;
  readonly organizationId: SafeId<"organization">;
  /** Thumbprint of the device key whose single-use proof signed the request. */
  readonly deviceJkt: string;
  /** The desktop credential that authorized it. */
  readonly keyId: string;
};

export type AuthorizeDesktopRunner = (
  request: Request,
) => Promise<Result<DesktopRunnerCaller, HandlerError<401 | 403 | 503>>>;

/**
 * Runner authorization from desktop account authorization: the account's
 * token, a live membership, and a single-use proof signed by the device key
 * bound to the token. That key's thumbprint binds the socket.
 */
export const authorizeRunnerWith =
  (authorizeAccount: typeof authorizeDesktopAccount): AuthorizeDesktopRunner =>
  async (request) =>
    (await authorizeAccount(request)).map((authorized) => ({
      userId: authorized.userId,
      organizationId: authorized.organizationId,
      deviceJkt: authorized.consumedProof.proof.thumbprint,
      keyId: authorized.keyId,
    }));

export type DesktopRunnerGatewayOptions = {
  db: DesktopRunnerDb;
  doorbell: DesktopRunnerDoorbell;
  /** This API task, the address other tasks ring. */
  instanceId: string;
  authorize: AuthorizeDesktopRunner;
  mintRunToken: MintRunToken;
  now?: () => Date;
  random?: () => number;
  timing?: Partial<DesktopRunnerTiming>;
  limits?: Partial<DesktopRunnerLimits>;
  /** Re-checked on every heartbeat; the owner connection's check by default. */
  isKeyLive?: DesktopKeyLiveness;
  /** The clock sockets schedule with; the system's by default. */
  timers?: RunnerTimers;
};

/** Leases expired per sweep, so one sweep stays one short transaction. */
const EXPIRY_BATCH = 100;
/** Sockets a sweep delivers to, at most; a ring reaches the rest. */
const SWEEP_DELIVERY_BATCH = 500;
/** Beyond two sweep intervals, so a command queued between sweeps is seen twice. */
const SWEEP_WINDOW_MARGIN_MS = 5000;
/** How long a draining task asks a refused desktop to wait before retrying. */
const DRAINING_RETRY_AFTER_S = 5;

const desktopIdSchema = v.pipe(v.string(), v.uuid());

const refusal = (status: number, message: string, code?: string) =>
  Response.json(code === undefined ? { message } : { message, code }, {
    status,
  });

export type DesktopRunnerGateway = {
  /**
   * Authenticate an upgrade request and open its socket. Answers a refusal,
   * or `null` once Bun has taken the request over.
   */
  readonly upgrade: (
    request: Request,
    server: HttpServer,
  ) => Promise<Response | null>;
  /** Listen for this task's doorbell and start the periodic sweep. */
  readonly start: () => Promise<void>;
  /** Expire lapsed leases, then deliver every local socket's queue. */
  readonly sweep: () => Promise<void>;
  /** Refuse new sockets and ask every open one to reconnect elsewhere. */
  readonly drain: () => Promise<void>;
  readonly openSessions: () => number;
};

/**
 * The API side of desktop runner sockets for one API task. Postgres holds every
 * queue; this task holds only the sockets it accepted. Another task reaches one
 * of them through the doorbell, and a sweep catches any ring that was lost.
 */
export const createDesktopRunnerGateway = (
  options: DesktopRunnerGatewayOptions,
): DesktopRunnerGateway => {
  const timing = { ...DESKTOP_RUNNER_TIMING, ...options.timing };
  const limits = { ...DESKTOP_RUNNER_LIMITS, ...options.limits };
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const sessions = new Map<string, RunnerSession>();
  /** Open sockets per account and organization on this task. */
  const openByAccount = new Map<string, number>();
  const accountOf = ({ userId, organizationId }: DesktopRunnerCaller) =>
    JSON.stringify([userId, organizationId]);
  const release = (account: string) => {
    const open = (openByAccount.get(account) ?? 1) - 1;
    if (open <= 0) {
      openByAccount.delete(account);
    } else {
      openByAccount.set(account, open);
    }
  };
  let draining = false;
  let sweepTimer: ReturnType<typeof setTimeout> | null = null;
  let stopListening: (() => Promise<void>) | null = null;

  const context = {
    db: options.db,
    instanceId: options.instanceId,
    timing,
    limits,
    timers: options.timers ?? SYSTEM_TIMERS,
    now,
    random,
    mintRunToken: options.mintRunToken,
    isKeyLive: options.isKeyLive ?? desktopKeyLiveness(),
    ringPrevious: options.doorbell.ring,
  };

  const deliverTo = async (sessionId: string) => {
    await sessions.get(sessionId)?.deliver();
  };

  const sweep = async () => {
    const expired = await Result.tryPromise(
      async () =>
        await expireRunLeases(options.db, { now: now(), limit: EXPIRY_BATCH }),
    );
    if (expired.isErr()) {
      // The next sweep expires them; a late expiry only delays the state.
      observeFailure(expired.error, { sink: LEASE_SWEEP_SINK });
    }
    const abandoned = await Result.tryPromise(
      async () =>
        await expireAbandonedRuns(options.db, {
          now: now(),
          abandonedMs: limits.abandonedRunMs,
          limit: EXPIRY_BATCH,
        }),
    );
    if (abandoned.isErr()) {
      observeFailure(abandoned.error, { sink: LEASE_SWEEP_SINK });
    }
    const pruned = await Result.tryPromise(
      async () =>
        await pruneEndedRuns(options.db, {
          now: now(),
          retentionMs: limits.endedRunRetentionMs,
          limit: EXPIRY_BATCH,
        }),
    );
    if (pruned.isErr()) {
      // Retention catches up on the next sweep.
      observeFailure(pruned.error, { sink: LEASE_SWEEP_SINK });
    }
    // Only sockets with commands queued in the window, one after another:
    // a sweep catches lost rings without touching every idle socket.
    const queued = await Result.tryPromise(
      async () =>
        await readSessionsWithQueuedCommands(options.db, {
          instanceId: options.instanceId,
          windowMs: 2 * timing.sweepIntervalMs + SWEEP_WINDOW_MARGIN_MS,
          limit: SWEEP_DELIVERY_BATCH,
        }),
    );
    if (queued.isErr()) {
      observeFailure(queued.error, { sink: LEASE_SWEEP_SINK });
      return;
    }
    for (const sessionId of queued.value) {
      // db-await-in-loop: one socket's delivery per iteration; each reads its own queue page by page
      await sessions.get(sessionId)?.deliver();
    }
  };

  const scheduleSweep = () => {
    // Spread over a fraction of the interval, so tasks started together drift apart.
    const delay = timing.sweepIntervalMs * (0.75 + 0.5 * random());
    sweepTimer = setTimeout(() => {
      detached(
        sweep().finally(() => {
          if (!draining) {
            scheduleSweep();
          }
        }),
        "desktop-runner.sweep",
      );
    }, delay);
  };

  const upgrade = async (
    request: Request,
    server: HttpServer,
  ): Promise<Response | null> => {
    if (draining) {
      return new Response("Reconnect to another server", {
        status: 503,
        headers: { "retry-after": String(DRAINING_RETRY_AFTER_S) },
      });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return refusal(426, "A runner connects over a WebSocket");
    }
    const desktopId = v.safeParse(
      desktopIdSchema,
      request.headers.get(DESKTOP_RUNNER_DESKTOP_ID_HEADER),
    );
    if (!desktopId.success) {
      return refusal(400, "The desktop installation id is missing");
    }
    const caller = await options.authorize(request);
    if (caller.isErr()) {
      return refusal(
        caller.error.status,
        caller.error.message,
        caller.error.code,
      );
    }
    // Each socket holds memory on this task, so one account holds only a few.
    const account = accountOf(caller.value);
    if ((openByAccount.get(account) ?? 0) >= limits.maxSocketsPerAccount) {
      return refusal(429, "Too many runner connections for this account");
    }
    const sessionId = Bun.randomUUIDv7();
    const session = createRunnerSession({
      context,
      binding: { ...caller.value, desktopId: desktopId.output },
      sessionId,
      onClosed: (closed) => {
        if (sessions.delete(closed)) {
          release(account);
        }
      },
    });
    sessions.set(sessionId, session);
    openByAccount.set(account, (openByAccount.get(account) ?? 0) + 1);
    if (
      !server.upgrade(request, { data: { session: session.socketSession } })
    ) {
      if (sessions.delete(sessionId)) {
        release(account);
      }
      return refusal(400, "The WebSocket upgrade failed");
    }
    return null;
  };

  return {
    upgrade,
    start: async () => {
      stopListening = await options.doorbell.listen(
        options.instanceId,
        (sessionId) => {
          detached(deliverTo(sessionId), "desktop-runner.ring");
        },
      );
      scheduleSweep();
    },
    sweep,
    drain: async () => {
      draining = true;
      if (sweepTimer !== null) {
        clearTimeout(sweepTimer);
      }
      for (const session of sessions.values()) {
        session.drain(Math.floor(random() * timing.drainSpreadMs));
      }
      await stopListening?.();
      stopListening = null;
    },
    openSessions: () => sessions.size,
  };
};
