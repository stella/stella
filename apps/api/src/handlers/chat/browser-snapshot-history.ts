import type { ModelMessage } from "@tanstack/ai";
import { Result } from "better-result";
import * as v from "valibot";

import {
  BROWSER_CONTROL_TOOL_NAME,
  browserControlResultSchema,
} from "@stll/api-contract/browser-control";

import type { ChatMessage, ChatPart } from "@/api/handlers/chat/types";
import { arrayOrEmpty } from "@/api/lib/array";

/**
 * Marks a `use-browser` result whose page snapshot a later one replaced. The
 * model reads it in place of the snapshot.
 */
export const SUPERSEDED_BROWSER_SNAPSHOT_NOTE =
  "Superseded by a later page read: this page's text and element refs are no longer in context and its refs are stale. Call `snapshot` (on its tab) to read it again.";

/**
 * Every successful browser command returns a whole page snapshot, so keeping
 * each one turns a browsing turn into a context that grows by a full page per
 * step. Element refs only stay valid for the newest snapshot, so the model
 * keeps that one in full; every earlier successful result shrinks to the page
 * it was on. Error results are already small and stay as they are.
 *
 * Returns the same array when nothing changed, so callers can tell a
 * projection from a no-op by reference.
 */
export const supersedeBrowserSnapshots = (
  messages: ModelMessage[],
): ModelMessage[] => {
  const browserCallIds = new Set(
    messages.flatMap((message) =>
      message.role === "assistant"
        ? arrayOrEmpty(message.toolCalls)
            .filter((call) => call.function.name === BROWSER_CONTROL_TOOL_NAME)
            .map((call) => call.id)
        : [],
    ),
  );
  if (browserCallIds.size === 0) {
    return messages;
  }

  return supersedeNewest(
    messages,
    (message) => readBrowserSnapshotResult(message, browserCallIds),
    (message, result) => ({
      ...message,
      content: JSON.stringify(supersededBrowserResult(result)),
    }),
  );
};

/**
 * The same rule over stored chat messages, for estimates of what the next
 * send gives the model (the context meter, the compaction trigger): each
 * superseded `use-browser` call part, mapped to the output the model reads in
 * place of its stored one. Stored parts stay as they are.
 */
export const supersededBrowserParts = (
  messages: readonly ChatMessage[],
): ReadonlyMap<ChatPart, SupersededBrowserResult> => {
  const parts = messages.flatMap((message) => message.parts);
  const superseded = new Map<ChatPart, SupersededBrowserResult>();
  supersedeNewest(
    parts,
    (part) =>
      part.type === "tool-call" && part.name === BROWSER_CONTROL_TOOL_NAME
        ? readBrowserSuccess(part.output)
        : null,
    (part, result) => {
      superseded.set(part, supersededBrowserResult(result));
      return part;
    },
  );
  return superseded;
};

/**
 * Keeps the newest item that carries a browser page whole and replaces every
 * earlier one. Returns the same array when nothing is superseded.
 */
const supersedeNewest = <T>(
  items: T[],
  read: (item: T) => BrowserSnapshotResult | null,
  replace: (item: T, result: BrowserSnapshotResult) => T,
): T[] => {
  const results = items.map(read);
  const newest = results.findLastIndex((result) => result !== null);
  if (results.slice(0, Math.max(newest, 0)).every((r) => r === null)) {
    return items;
  }
  return items.map((item, index) => {
    const result = results.at(index) ?? null;
    return index >= newest || result === null ? item : replace(item, result);
  });
};

export type SupersededBrowserResult = ReturnType<
  typeof supersededBrowserResult
>;

const supersededBrowserResult = ({
  snapshot,
  status,
}: BrowserSnapshotResult) => ({
  status,
  superseded: true,
  note: SUPERSEDED_BROWSER_SNAPSHOT_NOTE,
  page: {
    contentTrust: snapshot.contentTrust,
    tabId: snapshot.tabId,
    textTotalChars: snapshot.textTotalChars,
    title: snapshot.title,
    url: snapshot.url,
  },
});

type BrowserSnapshotResult = Extract<
  v.InferOutput<typeof browserControlResultSchema>,
  { status: "success" }
>;

const readBrowserSnapshotResult = (
  message: ModelMessage,
  browserCallIds: ReadonlySet<string>,
): BrowserSnapshotResult | null => {
  if (
    message.role !== "tool" ||
    message.toolCallId === undefined ||
    !browserCallIds.has(message.toolCallId) ||
    typeof message.content !== "string"
  ) {
    return null;
  }
  const content = message.content;
  const parsed = Result.try((): unknown => JSON.parse(content));
  return Result.isError(parsed) ? null : readBrowserSuccess(parsed.value);
};

const readBrowserSuccess = (output: unknown): BrowserSnapshotResult | null => {
  const result = v.safeParse(browserControlResultSchema, output);
  if (!result.success || result.output.status !== "success") {
    return null;
  }
  return result.output;
};
