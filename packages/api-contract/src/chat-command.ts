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
