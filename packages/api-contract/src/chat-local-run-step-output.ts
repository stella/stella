import * as v from "valibot";

/**
 * What a coding agent's step produced on the member's computer (a command's
 * output, a change's diff) stays on that computer. The chat keeps only the
 * step's call id, which names its run; a page on the same computer reads the
 * output from the desktop app's loopback bridge, never through the API.
 *
 * The API's part is a grant: for the member who owns the run, a short-lived
 * key derived from the run's output key, which the API handed the desktop in
 * `run.start` and the desktop keeps beside the run's outputs. The desktop
 * derives the same key from its own linked account, so a grant made for
 * another member, another organization or another run never verifies, and
 * each request is signed with it the way the bridge's other requests are
 * (`timestamp\nGET\npath`). Both ends follow `chat-local-run-step-output.fixtures.json`.
 */

/**
 * A harness mints call ids unique only within its own run, so chat keeps
 * every call of a local run under an id that starts with the run: stable
 * across the turn's pause and resume, and unique across the thread.
 */
export const CHAT_LOCAL_RUN_CALL_ID_MAX_LENGTH = 256;

const RUN_OF_CALL = /^([0-9a-f]{32})_./u;

/**
 * The chat call id of a harness call in run `runId`. An id too long for the
 * budget keeps its identity as `digest` (SHA-256 hex) of the harness id, so
 * two long ids never collapse into one call.
 */
export const chatLocalRunCallId = (
  runId: string,
  toolCallId: string,
  digest: (text: string) => string,
): string => {
  const run = runId.replaceAll("-", "");
  const prefixed = `${run}_${toolCallId}`;
  return prefixed.length <= CHAT_LOCAL_RUN_CALL_ID_MAX_LENGTH
    ? prefixed
    : `${run}_${digest(toolCallId)}`;
};

/** The run a local run's chat call id names, or `null` for any other id. */
export const chatLocalRunOfCall = (callId: string): string | null => {
  const run = RUN_OF_CALL.exec(callId)?.[1];
  if (run === undefined) {
    return null;
  }
  return [
    run.slice(0, 8),
    run.slice(8, 12),
    run.slice(12, 16),
    run.slice(16, 20),
    run.slice(20),
  ].join("-");
};

/**
 * The most of one step's output or diff the computer keeps, in UTF-8 bytes.
 * Past it, the rest is left out and the step says how much there was.
 */
export const CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES = 1024 * 1024;

/** How long a grant to read a run's step outputs lasts, in seconds. */
export const CHAT_LOCAL_RUN_STEP_OUTPUT_GRANT_SECONDS = 300;

const hexKeySchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u));

/** A run's output key, as `run.start` carries it. */
export const chatLocalRunOutputKeySchema = hexKeySchema;

/** What the API answers for a grant: the key and when it expires (Unix seconds). */
const chatLocalRunStepOutputGrantSchema = v.strictObject({
  key: hexKeySchema,
  expiresAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});
export type ChatLocalRunStepOutputGrant = v.InferOutput<
  typeof chatLocalRunStepOutputGrantSchema
>;

type GrantMessageOptions = {
  runId: string;
  userId: string;
  organizationId: string;
  expiresAt: number;
};

/** What a grant key signs, with the run's output key as the HMAC key. */
export const chatLocalRunStepOutputGrantMessage = ({
  runId,
  userId,
  organizationId,
  expiresAt,
}: GrantMessageOptions): string =>
  `stella.step-output-grant.v1\n${runId}\n${userId}\n${organizationId}\n${String(expiresAt)}`;

/**
 * The bridge path of one step's output. `stepKey` is the SHA-256 hex of the
 * step's chat call id, so a path names no harness id and is safe as a file
 * name on the computer.
 */
export const chatLocalRunStepOutputBridgePath = (
  runId: string,
  stepKey: string,
): string =>
  `/v1/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepKey)}/output`;

/** Headers a step output request and its answer carry beside the bridge proof. */
export const CHAT_LOCAL_RUN_STEP_OUTPUT_HEADERS = {
  /** The grant's expiry, which the desktop signs into its key again. */
  grantExpiresAt: "x-stella-bridge-grant",
  /** How many bytes the step produced, kept or not. */
  totalBytes: "x-stella-output-bytes",
} as const;
