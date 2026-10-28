import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";

/** Where a desktop opens its runner socket (`wss://<api>/v1/desktop/runner`). */
export const DESKTOP_RUNNER_ROUTE_PREFIX =
  `${STELLA_API_VERSION_PREFIX}/desktop/runner` as const;

/**
 * The installation id the desktop already reports with its presence. The
 * credential binds the device key; this names the installation the key runs
 * in, so runs can be bound to both.
 */
export const DESKTOP_RUNNER_DESKTOP_ID_HEADER = "stella-desktop-id";

/**
 * Why the API closed a runner socket. A desktop reconnects after every code
 * except `upgradeRequired` (until it is updated) and `superseded` (another
 * socket of the same installation took over). Refusals before the upgrade are
 * HTTP answers instead: 400 without a valid installation id, 401 or 403 from
 * account and device-proof authorization, 426 without a WebSocket upgrade,
 * 503 while the task drains.
 *
 * - `goingAway`: the API task is draining or the socket reached its maximum
 *   life; a `reconnect` frame with the delay to wait precedes it.
 * - `unsupportedData`: a binary frame; the protocol is JSON text.
 * - 1008, `policyViolation(reason)`: a frame the contract rejects
 *   (`not_json`, `unknown_type`, `invalid`), a message before `hello`
 *   (`hello_required`), a second `hello` (`hello_repeated`), a run message its
 *   run's state does not allow (`run_state`), or a chunk that is not a valid
 *   AG-UI event (`unfoldable_chunk`).
 * - `tooLarge`: a frame above `DESKTOP_RUNNER_MAX_FRAME_BYTES`.
 * - `overloaded`: the desktop sent frames faster than they could be stored.
 * - `internalError`: the API could not persist or read what it needed; the
 *   desktop resends everything after its last `ack`.
 * - `upgradeRequired`: `hello` named a protocol outside the accepted range;
 *   an `upgrade_required` frame with the range precedes it.
 * - `superseded`: a newer socket of the same installation was accepted.
 * - `heartbeatTimeout`: pings went unanswered.
 * - `sequenceGap`: a run message skipped a position; `welcome.resume` on the
 *   next socket says where to resume.
 * - `helloTimeout`: no `hello` arrived in time.
 * - `unknownRun`: a run message for a run this socket does not hold.
 */
export const DESKTOP_RUNNER_CLOSE = {
  goingAway: { code: 1001, reason: "going_away" },
  unsupportedData: { code: 1003, reason: "binary_frame" },
  tooLarge: { code: 1009, reason: "too_large" },
  internalError: { code: 1011, reason: "internal_error" },
  overloaded: { code: 1013, reason: "overloaded" },
  upgradeRequired: { code: 4001, reason: "upgrade_required" },
  superseded: { code: 4002, reason: "superseded" },
  heartbeatTimeout: { code: 4003, reason: "heartbeat_timeout" },
  sequenceGap: { code: 4004, reason: "sequence_gap" },
  helloTimeout: { code: 4005, reason: "hello_timeout" },
  unknownRun: { code: 4006, reason: "unknown_run" },
} as const;
export const DESKTOP_RUNNER_POLICY_VIOLATION_CODE = 1008;

/** The reason a `policyViolation` close carries. */
export const DESKTOP_RUNNER_POLICY_REASONS = [
  "not_json",
  "unknown_type",
  "invalid",
  "hello_required",
  "hello_repeated",
  "run_state",
  "unfoldable_chunk",
] as const;
export type DesktopRunnerPolicyReason =
  (typeof DESKTOP_RUNNER_POLICY_REASONS)[number];

export type DesktopRunnerClose =
  | (typeof DESKTOP_RUNNER_CLOSE)[keyof typeof DESKTOP_RUNNER_CLOSE]
  | {
      code: typeof DESKTOP_RUNNER_POLICY_VIOLATION_CODE;
      reason: DesktopRunnerPolicyReason;
    };

export const policyViolation = (
  reason: DesktopRunnerPolicyReason,
): DesktopRunnerClose => ({
  code: DESKTOP_RUNNER_POLICY_VIOLATION_CODE,
  reason,
});

/** How long the gateway waits for things and how long it holds them. */
export type DesktopRunnerTiming = {
  /** Between pings; two unanswered intervals close the socket. */
  readonly pingIntervalMs: number;
  /** A socket's life before the API asks the desktop to reconnect. */
  readonly maxSocketLifeMs: number;
  /** Before a socket that sent no `hello` is closed. */
  readonly helloTimeoutMs: number;
  /** A run's lease, renewed by every heartbeat of the socket holding it. */
  readonly leaseMs: number;
  /** How recently a runner must have been seen for routing to pick it. */
  readonly runnerFreshnessMs: number;
  /** Between sweeps for expired leases and commands a doorbell missed. */
  readonly sweepIntervalMs: number;
  /** Upper bound of the `reconnect` delay spread over a draining task's sockets. */
  readonly drainSpreadMs: number;
  /** A run's MCP token is refreshed when it has less than this left. */
  readonly tokenRefreshMarginMs: number;
};

export const DESKTOP_RUNNER_TIMING = {
  pingIntervalMs: 20_000,
  maxSocketLifeMs: 60 * 60_000,
  helloTimeoutMs: 10_000,
  leaseMs: 90_000,
  runnerFreshnessMs: 60_000,
  sweepIntervalMs: 15_000,
  drainSpreadMs: 30_000,
  tokenRefreshMarginMs: 5 * 60_000,
} as const satisfies DesktopRunnerTiming;
