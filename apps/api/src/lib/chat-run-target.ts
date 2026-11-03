import { panic } from "better-result";
import * as v from "valibot";

import {
  CHAT_CLOUD_RUN_TARGET,
  CHAT_RUN_TARGET_KIND,
  type ChatRunTarget,
  chatRunTargetSchema,
} from "@stll/api-contract/chat-run-target";

const SEPARATOR = "::";

/**
 * The thread column's value for a run target: `"<harness>::<model>"` for a
 * computer, null for stella's own models.
 */
export const encodeChatRunTarget = (target: ChatRunTarget): string | null => {
  switch (target.kind) {
    case CHAT_RUN_TARGET_KIND.cloud:
      return null;
    case "local":
      return `${target.harness}${SEPARATOR}${target.model}`;
    default:
      target satisfies never;
      return panic("Unknown run target");
  }
};

/**
 * The run target a thread column holds. A value that no longer names a
 * harness a chat turn can run on reads as cloud: the composer then shows
 * cloud, and a send still carries its own target, so nothing is rerouted.
 */
export const decodeChatRunTarget = (value: string | null): ChatRunTarget => {
  if (value === null) {
    return CHAT_CLOUD_RUN_TARGET;
  }
  const at = value.indexOf(SEPARATOR);
  if (at === -1) {
    return CHAT_CLOUD_RUN_TARGET;
  }
  const parsed = v.safeParse(chatRunTargetSchema, {
    kind: "local",
    harness: value.slice(0, at),
    model: value.slice(at + SEPARATOR.length),
  });
  return parsed.success ? parsed.output : CHAT_CLOUD_RUN_TARGET;
};
