import { DAY_IN_MS } from "@stll/time";

/**
 * Commands a chat client sends with an id of its own, so a retry after a lost
 * response learns what became of the first attempt instead of acting twice.
 *
 * The client mints the id once per member action (one send, one answer) and
 * sends it on every retry of that action in `CHAT_COMMAND_ID_HEADER`. The
 * server stores a receipt in the transaction that accepts the command; a
 * request whose id already has one is not run again and is answered with
 * `CHAT_COMMAND_ERROR_CODE.replayed` (status 409) naming the turn the first
 * attempt started or continued in the chat turn id header. Only accepted
 * commands leave a receipt: every refusal depends on state that changes, so
 * a refused command runs again when retried.
 */
export const CHAT_COMMAND_ID_HEADER = "x-stella-chat-command-id";

/** What a receipt records a command as. */
export const CHAT_COMMAND_TYPES = ["send", "answer"] as const;
export type ChatCommandType = (typeof CHAT_COMMAND_TYPES)[number];

export const CHAT_COMMAND_ERROR_CODE = {
  /**
   * The command was accepted earlier: the turn header names the turn it
   * started or continued. Not a refusal: the client reads the thread and
   * joins that turn.
   */
  replayed: "chat_command_replayed",
  /** The id is a receipt of another thread or of another kind of command. */
  conflict: "chat_command_conflict",
  /** The command id is not a UUID. */
  invalidId: "chat_command_id_invalid",
} as const;

/** How long a receipt answers a retry; older ones are deleted. */
export const CHAT_COMMAND_RECEIPT_RETENTION_MS = DAY_IN_MS;

/**
 * How often a client sends a command again after losing its response (a
 * connection error, or no answer within `CHAT_COMMAND_CONFIRMATION_MS`): at
 * most twice, so three attempts in all, each under the same command id. A
 * response that arrived, a refusal included, is never retried.
 */
export const CHAT_COMMAND_MAX_RETRIES = 2;

/**
 * How long a client waits for an attempt's answer before it asks again under
 * the same id. The attempt it asks after is left to finish: a server still
 * preparing the turn would otherwise see the member leave and stop it.
 */
export const CHAT_COMMAND_CONFIRMATION_MS = 60_000;

/**
 * What became of a command whose response arrived: accepted (a 2xx stream);
 * replayed, when an earlier attempt of it was accepted and the server names
 * that turn, which the client joins as its own; or refused. A replay is never
 * a refusal: this is the one place that tells them apart.
 */
export type ChatCommandOutcome =
  | { type: "accepted" }
  | { type: "replayed"; turnId: string }
  | { type: "refused" };

export const chatCommandOutcomeOf = ({
  code,
  status,
  turnId,
}: {
  /** The refusal's error code, when its body carried one. */
  code: string | undefined;
  status: number;
  /** The chat turn id header of the response, if any. */
  turnId: string | null;
}): ChatCommandOutcome => {
  if (status >= 200 && status < 300) {
    return { type: "accepted" };
  }
  return status === 409 &&
    code === CHAT_COMMAND_ERROR_CODE.replayed &&
    turnId !== null
    ? { type: "replayed", turnId }
    : { type: "refused" };
};
