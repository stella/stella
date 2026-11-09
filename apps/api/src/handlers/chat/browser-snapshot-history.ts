import type { ModelMessage } from "@tanstack/ai";
import { Result } from "better-result";
import * as v from "valibot";

import {
  BROWSER_CONTROL_TOOL_NAME,
  browserControlResultSchema,
} from "@stll/api-contract/browser-control";

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

  const results = messages.map((message) =>
    readBrowserSnapshotResult(message, browserCallIds),
  );
  // The newest snapshot stays whole; only the ones before it shrink.
  const newest = results.findLastIndex((result) => result !== null);
  if (results.slice(0, Math.max(newest, 0)).every((r) => r === null)) {
    return messages;
  }

  return messages.map((message, index) => {
    const result = results.at(index) ?? null;
    if (index >= newest || result === null) {
      return message;
    }
    const { snapshot } = result;
    return {
      ...message,
      content: JSON.stringify({
        status: result.status,
        superseded: true,
        note: SUPERSEDED_BROWSER_SNAPSHOT_NOTE,
        page: {
          contentTrust: snapshot.contentTrust,
          tabId: snapshot.tabId,
          textTotalChars: snapshot.textTotalChars,
          title: snapshot.title,
          url: snapshot.url,
        },
      }),
    };
  });
};

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
  if (Result.isError(parsed)) {
    return null;
  }
  const result = v.safeParse(browserControlResultSchema, parsed.value);
  if (!result.success || result.output.status !== "success") {
    return null;
  }
  return result.output;
};
