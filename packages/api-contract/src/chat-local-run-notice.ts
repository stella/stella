import { panic } from "better-result";
import * as v from "valibot";

// A leaf: the computer's sidecar writes a notice, the server keeps it on the
// answer, and the web and the phone read it without the runner protocol.

/**
 * What a run on the member's computer says about itself that is neither part
 * of the answer nor a failure: the turn goes on. A notice names a condition,
 * never the harness's own text, so it carries no path, key or setting from
 * the member's machine.
 *
 * - `retrying`: a model request failed in a way the harness retries on its
 *   own. `attempt` and `maxAttempts` are the harness's count where it gives
 *   one. `status` follows the condition: `retrying` while it lasts,
 *   `recovered` once the harness made progress again, `ended` when the turn
 *   ended still retrying (its failure or stop then says what happened).
 * - `config_warning`: the harness warned about its own configuration on the
 *   computer and ran on.
 * - `capability_unavailable`: something the turn was offered could not be
 *   started for it (the browser's server), so the agent works without it.
 *
 * A later kind is added to this union, and every reader then has to decide
 * how it reads.
 */
export const CHAT_LOCAL_RUN_NOTICE_KINDS = [
  "retrying",
  "config_warning",
  "capability_unavailable",
] as const;
export type ChatLocalRunNoticeKind =
  (typeof CHAT_LOCAL_RUN_NOTICE_KINDS)[number];

export const CHAT_LOCAL_RUN_RETRY_STATUSES = [
  "retrying",
  "recovered",
  "ended",
] as const;
export type ChatLocalRunRetryStatus =
  (typeof CHAT_LOCAL_RUN_RETRY_STATUSES)[number];

/** What a turn may be offered and then find unavailable. */
export const CHAT_LOCAL_RUN_NOTICE_CAPABILITIES = ["browser"] as const;
export type ChatLocalRunNoticeCapability =
  (typeof CHAT_LOCAL_RUN_NOTICE_CAPABILITIES)[number];

/** The harness's own retry count: bounded, so a desktop cannot inflate it. */
const attemptSchema = v.nullable(
  v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000)),
);

export const chatLocalRunNoticeSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("retrying"),
    status: v.picklist(CHAT_LOCAL_RUN_RETRY_STATUSES),
    attempt: attemptSchema,
    maxAttempts: attemptSchema,
  }),
  v.strictObject({ kind: v.literal("config_warning") }),
  v.strictObject({
    kind: v.literal("capability_unavailable"),
    capability: v.picklist(CHAT_LOCAL_RUN_NOTICE_CAPABILITIES),
  }),
]);
export type ChatLocalRunNotice = v.InferOutput<typeof chatLocalRunNoticeSchema>;

/**
 * The CUSTOM stream event a computer's sidecar reports a notice with, its
 * value one `ChatLocalRunNotice`. The server keeps it on the answer
 * (`CHAT_LOCAL_RUN_NOTICES_METADATA_KEY`); the event itself goes no further.
 */
export const DESKTOP_RUNNER_NOTICE_EVENT = "desktop-runner.notice";

/**
 * Which notices are the same condition: one line per key. A retry collapses
 * into one line that updates; a config warning or a missing capability is
 * said once per run.
 */
export const chatLocalRunNoticeKey = (notice: ChatLocalRunNotice): string => {
  switch (notice.kind) {
    case "retrying":
    case "config_warning":
      return notice.kind;
    case "capability_unavailable":
      return `${notice.kind}:${notice.capability}`;
    default:
      notice satisfies never;
      return panic("Unknown local run notice");
  }
};

/** Most notices one answer names: one per key. */
export const CHAT_LOCAL_RUN_MAX_NOTICES =
  CHAT_LOCAL_RUN_NOTICE_KINDS.length -
  1 +
  CHAT_LOCAL_RUN_NOTICE_CAPABILITIES.length;

const sameNotice = (a: ChatLocalRunNotice, b: ChatLocalRunNotice) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * `notices` with `notice` taken in, or `null` when that changes nothing. A
 * notice replaces the one of its key in place (a retry's next attempt, its
 * recovery, a new retry after one recovered). A list already holding one
 * notice per key takes no new key.
 */
export const withChatLocalRunNotice = (
  notices: readonly ChatLocalRunNotice[],
  notice: ChatLocalRunNotice,
): readonly ChatLocalRunNotice[] | null => {
  const key = chatLocalRunNoticeKey(notice);
  const index = notices.findIndex(
    (held) => chatLocalRunNoticeKey(held) === key,
  );
  if (index === -1) {
    return notices.length >= CHAT_LOCAL_RUN_MAX_NOTICES
      ? null
      : [...notices, notice];
  }
  const held = notices[index];
  if (held === undefined || sameNotice(held, notice)) {
    return null;
  }
  return notices.map((each, at) => (at === index ? notice : each));
};

/**
 * `notices` with a retry still under way settled as `ended`, or `null` when
 * none is: the run ended, so nothing is being retried any more.
 */
export const endedChatLocalRunNotices = (
  notices: readonly ChatLocalRunNotice[],
): readonly ChatLocalRunNotice[] | null =>
  notices.some(
    (notice) => notice.kind === "retrying" && notice.status === "retrying",
  )
    ? notices.map((notice) =>
        notice.kind === "retrying" && notice.status === "retrying"
          ? { ...notice, status: "ended" }
          : notice,
      )
    : null;

/**
 * Message metadata: every notice the answer's run gave, each in its latest
 * state. The stream restates the whole list on each change (a stream
 * processor merges metadata key by key) and the stored answer keeps it, so a
 * live answer and a reloaded one read the same.
 */
export const CHAT_LOCAL_RUN_NOTICES_METADATA_KEY = "localRunNotices";

export const chatLocalRunNoticesSchema = v.pipe(
  v.array(chatLocalRunNoticeSchema),
  v.maxLength(CHAT_LOCAL_RUN_MAX_NOTICES),
);

/** The notices a message's metadata names; none when it names none or they do not read. */
export const chatLocalRunNoticesOf = (
  metadata: unknown,
): readonly ChatLocalRunNotice[] => {
  if (typeof metadata !== "object" || metadata === null) {
    return [];
  }
  const parsed = v.safeParse(
    chatLocalRunNoticesSchema,
    Reflect.get(metadata, CHAT_LOCAL_RUN_NOTICES_METADATA_KEY),
  );
  return parsed.success ? parsed.output : [];
};

/**
 * Whether a notice still has something to say: a retry that ended with its
 * turn says nothing beside the turn's own failure or stop.
 */
export const isChatLocalRunNoticeShown = (
  notice: ChatLocalRunNotice,
): boolean => notice.kind !== "retrying" || notice.status !== "ended";
